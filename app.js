const { App } = require('@slack/bolt');
const axios = require('axios');
require('dotenv').config();

// Initialize your app with your bot token and signing secret
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
  port: process.env.PORT || 3000
});

// GROK API integration function with conversation context
async function callGrokAPI(message, userId, conversationHistory = []) {
  try {
    console.log('Calling GROK API with message:', message);
    console.log('XAI_API_KEY available:', !!process.env.XAI_API_KEY);
    
    // Build messages array with conversation history
    const messages = [
      {
        role: 'system',
        content: 'You are a helpful AI assistant integrated into Slack. Be concise and helpful in your responses. Maintain context from previous messages in the conversation.'
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
      // Skip the first message (original mention) and bot messages
      if (message.ts === threadTs || message.bot_id) continue;
      
      // Determine role based on whether it's from a bot or user
      const role = message.bot_id ? 'assistant' : 'user';
      messages.push({
        role: role,
        content: message.text
      });
    }
    
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

// Listen to direct messages
app.event('message', async ({ event, say, client }) => {
  // Skip messages from bots (including ourselves)
  if (event.bot_id || event.subtype) {
    return;
  }

  // Only respond to direct messages (channel type 'im')
  if (event.channel_type === 'im') {
    try {
      // Show typing indicator
      await client.conversations.mark({
        channel: event.channel,
        ts: event.ts
      });

      // Get conversation history for DMs (use channel as thread)
      let conversationHistory = [];
      if (event.thread_ts) {
        conversationHistory = await getConversationHistory(client, event.channel, event.thread_ts);
      } else {
        // For DMs without threads, get recent message history
        const result = await client.conversations.history({
          channel: event.channel,
          limit: 10
        });
        
        const messages = [];
        for (const message of result.messages) {
          if (message.ts === event.ts || message.bot_id) continue;
          const role = message.bot_id ? 'assistant' : 'user';
          messages.push({
            role: role,
            content: message.text
          });
        }
        conversationHistory = messages.reverse(); // Reverse to get chronological order
      }

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
    await app.start();
    console.log('⚡️ Slack AI Assistant is running!');
  } catch (error) {
    console.error('Failed to start the app:', error);
    process.exit(1);
  }
})();
