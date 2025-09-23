const { App } = require('@slack/bolt');
const axios = require('axios');
const redisService = require('./services/redisService');
const integrationService = require('./services/integrationService');
require('dotenv').config();

// Initialize your app with your bot token and signing secret
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
  port: process.env.PORT || 3000
});

// GROK API integration function with conversation context and integration support
async function callGrokAPI(message, userId, conversationHistory = [], teamId = null) {
  try {
    console.log('Calling GROK API with message:', message);
    console.log('XAI_API_KEY available:', !!process.env.XAI_API_KEY);
    
    // Get available integrations for this team
    let availableIntegrations = [];
    if (teamId) {
      availableIntegrations = await redisService.listIntegrations(teamId);
    }
    
    // Build system prompt with integration capabilities
    let systemPrompt = 'You are a helpful AI assistant integrated into Slack. Be concise and helpful in your responses. Maintain context from previous messages in the conversation.';
    
    if (availableIntegrations.length > 0) {
      systemPrompt += `\n\nYou have access to the following integrations: ${availableIntegrations.join(', ')}. When users ask about creating tickets, searching issues, or other integration tasks, you can help them with these tools.`;
    }
    
    // Build messages array with conversation history
    const messages = [
      {
        role: 'system',
        content: systemPrompt
      },
      ...conversationHistory,
      {
        role: 'user',
        content: message
      }
    ];
    
    const requestBody = {
      model: 'grok-2',
      messages: messages,
      max_tokens: 1000,
      temperature: 0.7
    };
    
    console.log('Request body:', JSON.stringify(requestBody, null, 2));
    
    const response = await axios.post('https://api.x.ai/v1/chat/completions', requestBody, {
      headers: {
        'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('GROK API Response:', response.data);
    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('GROK API Error:', error.response?.data || error.message);
    console.error('Full error:', error);
    throw new Error('Failed to get AI response');
  }
}

// Helper function to get conversation history from thread
async function getConversationHistory(client, channelId, threadTs) {
  try {
    const result = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 20 // Get last 20 messages for context
    });
    
    const messages = [];
    for (const message of result.messages) {
      // Skip the first message (original mention)
      if (message.ts === threadTs) continue;
      
      // Determine role based on whether it's from a bot or user
      const role = message.bot_id ? 'assistant' : 'user';
      messages.push({
        role: role,
        content: message.text
      });
    }
    
    console.log('Conversation history:', messages);
    return messages;
  } catch (error) {
    console.error('Error getting conversation history:', error);
    return [];
  }
}

// Listen to messages that mention the bot
app.event('app_mention', async ({ event, say, client }) => {
  try {
    // Extract the message text without the mention
    const messageText = event.text.replace(/<@[^>]+>/g, '').trim();
    
    if (!messageText) {
      await say('Hello! How can I help you today?');
      return;
    }

    // Show typing indicator
    await client.conversations.mark({
      channel: event.channel,
      ts: event.ts
    });

    // Get conversation history if this is a thread reply
    let conversationHistory = [];
    if (event.thread_ts) {
      conversationHistory = await getConversationHistory(client, event.channel, event.thread_ts);
    }

    // Get AI response from GROK with conversation context
    const aiResponse = await callGrokAPI(messageText, event.user, conversationHistory);
    
    // Reply with the AI response in the same thread
    await say({
      text: aiResponse,
      thread_ts: event.ts
    });
  } catch (error) {
    console.error('Error processing mention:', error);
    console.error('Error details:', error.message);
    await say({
      text: `Sorry, I encountered an error: ${error.message}. Please try again.`,
      thread_ts: event.ts
    });
  }
});

// Slash command handler
app.command('/ai', async ({ command, ack, say, respond }) => {
  await ack();

  try {
    const query = command.text.trim();
    
    if (!query) {
      await respond('Please provide a question or request. Usage: `/ai <your question>`');
      return;
    }

    // Show typing indicator
    await say('Thinking... 🤔');

    // Get AI response from GROK
    const aiResponse = await callGrokAPI(query, command.user_id);
    
    // Reply with the AI response
    await respond({
      text: aiResponse,
      response_type: 'in_channel'
    });
  } catch (error) {
    console.error('Error processing slash command:', error);
    await respond('Sorry, I encountered an error processing your request. Please try again.');
  }
});

// Listen to AI Assistant thread started events
app.event('assistant_thread_started', async ({ event, say, client }) => {
  try {
    console.log('AI Assistant thread started:', event);
    await say('Hello! How can I help you today?');
  } catch (error) {
    console.error('Error handling assistant thread started:', error);
  }
});

// Listen to AI Assistant thread context changed events
app.event('assistant_thread_context_changed', async ({ event, say, client }) => {
  try {
    console.log('AI Assistant thread context changed:', event);
    // Handle context changes if needed
  } catch (error) {
    console.error('Error handling assistant thread context changed:', error);
  }
});

// Listen to messages in AI Assistant threads
app.event('message', async ({ event, say, client }) => {
  // Skip messages from bots (including ourselves)
  if (event.bot_id || event.subtype) {
    return;
  }

  // Handle AI Assistant messages (channel type 'im' and has thread_ts)
  if (event.channel_type === 'im' && event.thread_ts) {
    try {
      console.log('Processing AI Assistant message:', event);
      
      // Show typing indicator
      await client.conversations.mark({
        channel: event.channel,
        ts: event.ts
      });

      // Get conversation history for AI Assistant thread
      let conversationHistory = [];
      conversationHistory = await getConversationHistory(client, event.channel, event.thread_ts);

      // Get AI response from GROK with conversation context
      const aiResponse = await callGrokAPI(event.text, event.user, conversationHistory);
      
      // Reply with the AI response in the same thread
      await say({
        text: aiResponse,
        thread_ts: event.thread_ts
      });
    } catch (error) {
      console.error('Error processing AI Assistant message:', error);
      await say({
        text: 'Sorry, I encountered an error processing your request. Please try again.',
        thread_ts: event.thread_ts
      });
    }
  }
  // Handle regular DM messages (no thread_ts)
  else if (event.channel_type === 'im' && !event.thread_ts) {
    try {
      // Show typing indicator
      await client.conversations.mark({
        channel: event.channel,
        ts: event.ts
      });

      // Get conversation history for DMs (use channel as thread)
      let conversationHistory = [];
      // For DMs without threads, get recent message history
      const result = await client.conversations.history({
        channel: event.channel,
        limit: 10
      });
      
      const messages = [];
      for (const message of result.messages) {
        if (message.ts === event.ts) continue; // Skip current message
        const role = message.bot_id ? 'assistant' : 'user';
        messages.push({
          role: role,
          content: message.text
        });
      }
      conversationHistory = messages.reverse(); // Reverse to get chronological order
      console.log('DM conversation history:', conversationHistory);

      // Get AI response from GROK with conversation context
      const aiResponse = await callGrokAPI(event.text, event.user, conversationHistory);
      
      // Reply with the AI response
      await say(aiResponse);
    } catch (error) {
      console.error('Error processing DM:', error);
      await say('Sorry, I encountered an error processing your request. Please try again.');
    }
  }
});

// Home tab handler
app.event('app_home_opened', async ({ event, client }) => {
  try {
    await client.views.publish({
      user_id: event.user,
      view: {
        type: 'home',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Welcome to your AI Assistant! 🤖*\n\nI can help you with various tasks. Here are some ways to interact with me:\n\n• *Mention me* in any channel: `@AI Assistant <your question>`\n• *Use the slash command*: `/ai <your question>`\n• *Send me a direct message* with your questions\n\nWhat would you like to know?'
            }
          },
          {
            type: 'divider'
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Quick Actions:*'
            }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'Help'
                },
                action_id: 'help_button',
                style: 'primary'
              }
            ]
          }
        ]
      }
    });
  } catch (error) {
    console.error('Error publishing home view:', error);
  }
});

// Button click handler
app.action('help_button', async ({ ack, say }) => {
  await ack();
  await say('I\'m an AI assistant powered by GROK! I can help you with questions, provide information, and assist with various tasks. Just ask me anything!');
});

// Integration management commands
app.command('/setup-jira', async ({ command, ack, respond, client }) => {
  await ack();
  
  try {
    const teamId = command.team_id;
    
    // Send a modal for Jira setup
    await client.views.open({
      trigger_id: command.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'jira_setup',
        title: {
          type: 'plain_text',
          text: 'Setup Jira Integration'
        },
        submit: {
          type: 'plain_text',
          text: 'Save'
        },
        close: {
          type: 'plain_text',
          text: 'Cancel'
        },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'Configure your Jira integration credentials:'
            }
          },
          {
            type: 'input',
            block_id: 'jira_url',
            element: {
              type: 'plain_text_input',
              action_id: 'url',
              placeholder: {
                type: 'plain_text',
                text: 'https://yourcompany.atlassian.net'
              }
            },
            label: {
              type: 'plain_text',
              text: 'Jira Base URL'
            }
          },
          {
            type: 'input',
            block_id: 'jira_username',
            element: {
              type: 'plain_text_input',
              action_id: 'username',
              placeholder: {
                type: 'plain_text',
                text: 'your.email@company.com'
              }
            },
            label: {
              type: 'plain_text',
              text: 'Jira Username/Email'
            }
          },
          {
            type: 'input',
            block_id: 'jira_token',
            element: {
              type: 'plain_text_input',
              action_id: 'token',
              placeholder: {
                type: 'plain_text',
                text: 'Your Jira API Token'
              }
            },
            label: {
              type: 'plain_text',
              text: 'Jira API Token'
            }
          }
        ]
      }
    });
  } catch (error) {
    console.error('Error opening Jira setup modal:', error);
    await respond('Sorry, there was an error opening the setup form. Please try again.');
  }
});

// Handle Jira setup modal submission
app.view('jira_setup', async ({ ack, body, view, client }) => {
  await ack();
  
  try {
    const teamId = body.team.id;
    const values = view.state.values;
    
    const credentials = {
      baseUrl: values.jira_url.url.value,
      username: values.jira_username.username.value,
      apiToken: values.jira_token.token.value
    };
    
    // Validate credentials
    const isValid = await integrationService.validateCredentials('jira', credentials);
    
    if (isValid) {
      // Save credentials
      await redisService.saveCredentials(teamId, 'jira', credentials);
      
      await client.chat.postMessage({
        channel: body.user.id,
        text: '✅ Jira integration configured successfully! You can now ask me to create tickets, search issues, and more.'
      });
    } else {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Invalid Jira credentials. Please check your URL, username, and API token and try again.'
      });
    }
  } catch (error) {
    console.error('Error processing Jira setup:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Sorry, there was an error setting up Jira integration. Please try again.'
    });
  }
});

// List integrations command
app.command('/integrations', async ({ command, ack, respond }) => {
  await ack();
  
  try {
    const teamId = command.team_id;
    const integrations = await redisService.listIntegrations(teamId);
    
    if (integrations.length === 0) {
      await respond('No integrations configured yet. Use `/setup-jira` to configure Jira integration.');
    } else {
      await respond(`Configured integrations: ${integrations.join(', ')}`);
    }
  } catch (error) {
    console.error('Error listing integrations:', error);
    await respond('Sorry, there was an error listing integrations.');
  }
});

// Add request logging middleware
app.use(async ({ next }) => {
  console.log('Processing Slack request...');
  await next();
});


// Error handling
app.error((error) => {
  console.error('App error:', error);
});

// Start the app
(async () => {
  try {
    // Connect to Redis
    const redisConnected = await redisService.connect();
    if (redisConnected) {
      console.log('✅ Redis connected successfully');
    } else {
      console.log('⚠️ Redis connection failed - continuing without Redis');
    }

    await app.start();
    console.log('⚡️ Slack AI Assistant is running!');
    console.log('Environment check:');
    console.log('- SLACK_BOT_TOKEN:', process.env.SLACK_BOT_TOKEN ? 'Set' : 'Missing');
    console.log('- SLACK_SIGNING_SECRET:', process.env.SLACK_SIGNING_SECRET ? 'Set' : 'Missing');
    console.log('- XAI_API_KEY:', process.env.XAI_API_KEY ? 'Set' : 'Missing');
    console.log('- REDIS_URL:', process.env.REDIS_URL ? 'Set' : 'Missing');
    console.log('- PORT:', process.env.PORT || 3000);
  } catch (error) {
    console.error('Failed to start the app:', error);
    process.exit(1);
  }
})();
