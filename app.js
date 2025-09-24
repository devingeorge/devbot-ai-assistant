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
  port: process.env.PORT || 3000,
  installationStore: {
    storeInstallation: redisService.saveInstallation.bind(redisService),
    fetchInstallation: redisService.getInstallation.bind(redisService),
    deleteInstallation: redisService.deleteInstallation.bind(redisService),
  }
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
    
    // Check if this is a Jira ticket creation request
    const isJiraTicketRequest = message.toLowerCase().includes('create') && 
                               (message.toLowerCase().includes('jira') || message.toLowerCase().includes('ticket'));
    
    console.log('Jira detection debug:', {
      message: message,
      isJiraTicketRequest: isJiraTicketRequest,
      availableIntegrations: availableIntegrations,
      teamId: teamId
    });
    
    if (isJiraTicketRequest && availableIntegrations.includes('jira')) {
      console.log('Detected Jira ticket creation request');
      
      // Extract ticket details from the message
      const ticketSummary = message.replace(/create.*?(?:jira\s+)?ticket\s*(?:about|for)?\s*/i, '').trim() || 'Ticket created via Slack AI Assistant';
      
      try {
        // Create the Jira ticket
        const result = await integrationService.handleIntegration('jira', 'create_ticket', {
          summary: ticketSummary,
          description: `Ticket created via Slack AI Assistant\n\nOriginal request: ${message}`,
          issueType: 'Task'
        }, teamId);
        
        if (result.success) {
          return `✅ Created Jira ticket ${result.ticketKey}: ${result.message}\n\n🔗 ${result.ticketUrl}`;
        } else {
          return `❌ Failed to create Jira ticket: ${result.error || 'Unknown error'}`;
        }
      } catch (error) {
        console.error('Error creating Jira ticket:', error);
        return `❌ Failed to create Jira ticket: ${error.message}`;
      }
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
    const aiResponse = await callGrokAPI(messageText, event.user, conversationHistory, event.team);
    
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
    const aiResponse = await callGrokAPI(query, command.user_id, [], command.team_id);
    
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
app.event('assistant_thread_started', async ({ event, client }) => {
  try {
    console.log('AI Assistant thread started:', event);
    
    // Get channel ID from assistant_thread object
    const channelId = event.assistant_thread?.channel_id;
    if (!channelId) {
      console.log('No channel information in assistant_thread_started event');
      return;
    }
    
    // Get team ID from the event context
    const teamId = event.team || 'unknown';
    
    // Get suggested prompts for this team
    const prompts = await redisService.getAllSuggestedPrompts(teamId);
    console.log('Retrieved prompts for team:', teamId, prompts);
    const enabledPrompts = prompts.filter(prompt => prompt.enabled !== false);
    console.log('Enabled prompts:', enabledPrompts);
    
    // Set suggested prompts if any exist
    if (enabledPrompts.length > 0) {
      try {
        const suggestedPrompts = enabledPrompts.map(prompt => ({
          title: prompt.buttonText,
          prompt: prompt.messageText
        }));
        
        console.log('Setting suggested prompts:', suggestedPrompts);
        console.log('Channel ID:', channelId);
        console.log('Thread TS:', event.assistant_thread.thread_ts);
        
        // Try the correct API method
        const result = await client.assistant.threads.setSuggestedPrompts({
          channel_id: channelId,
          thread_ts: event.assistant_thread.thread_ts,
          prompts: suggestedPrompts
        });
        
        console.log('Successfully set suggested prompts for thread:', result);
      } catch (promptError) {
        console.error('Error setting suggested prompts:', promptError);
        console.error('Full error details:', promptError.response?.data || promptError.message);
        // Continue with welcome message even if prompts fail
      }
    } else {
      console.log('No enabled prompts found for team:', teamId);
    }
    
    // Post a welcome message in the AI Assistant thread
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: event.assistant_thread.thread_ts,
      text: 'Hello! How can I help you today?'
    });
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
app.event('message', async ({ event, say, client, context }) => {
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
      console.log('Context object in app.message:', context);
      const aiResponse = await callGrokAPI(event.text, event.user, conversationHistory, context.teamId);
      
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
      const aiResponse = await callGrokAPI(event.text, event.user, conversationHistory, context.teamId);
      
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
              text: '*Welcome to AI Assistant!* 🤖\n\nI\'m your intelligent AI assistant powered by GROK. I can help you with questions, provide information, and assist with various tasks.'
            }
          },
          {
            type: 'divider'
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Available Commands:*\n• `/ai <question>` - Ask me anything\n• `/integrations` - List configured integrations\n• Mention me in channels: `@AI Assistant help`'
            }
          },
          {
            type: 'divider'
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Integrations:*\nConfigure integrations to extend my capabilities:'
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Suggested Prompts:*\nCreate quick-start prompts that appear as buttons in the AI Assistant pane:'
            }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '➕ Add Prompt'
                },
                action_id: 'add_suggested_prompt_button',
                style: 'primary'
              },
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '📋 View Prompts'
                },
                action_id: 'view_suggested_prompts_button'
              }
            ]
          },
          {
            type: 'divider'
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Integrations:*\nConfigure integrations to extend my capabilities:'
            }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '🔧 Setup Jira'
                },
                action_id: 'setup_jira_button',
                style: 'primary'
              },
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '❓ Help'
                },
                action_id: 'help_button'
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

// Add suggested prompt button handler
app.action('add_suggested_prompt_button', async ({ ack, body, client }) => {
  await ack();
  
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'add_suggested_prompt',
        title: {
          type: 'plain_text',
          text: 'Add Suggested Prompt'
        },
        submit: {
          type: 'plain_text',
          text: 'Add Prompt'
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
              text: 'Create a suggested prompt that will appear as a button in the AI Assistant pane.'
            }
          },
          {
            type: 'input',
            block_id: 'prompt_button_text',
            element: {
              type: 'plain_text_input',
              action_id: 'button_text',
              placeholder: {
                type: 'plain_text',
                text: 'e.g., "Create a bug report"'
              },
              max_length: 75
            },
            label: {
              type: 'plain_text',
              text: 'Button Text'
            }
          },
          {
            type: 'input',
            block_id: 'prompt_message',
            element: {
              type: 'plain_text_input',
              action_id: 'message_text',
              multiline: true,
              placeholder: {
                type: 'plain_text',
                text: 'e.g., "Create a Jira ticket for a bug report with the following details: [describe the issue]"'
              },
              max_length: 2000
            },
            label: {
              type: 'plain_text',
              text: 'Message to Send'
            }
          }
        ]
      }
    });
  } catch (error) {
    console.error('Error opening add prompt modal:', error);
  }
});

// View suggested prompts button handler
app.action('view_suggested_prompts_button', async ({ ack, body, client }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    const prompts = await redisService.getAllSuggestedPrompts(teamId);
    
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Suggested Prompts* (${prompts.length} total)`
        }
      },
      {
        type: 'divider'
      }
    ];
    
    if (prompts.length === 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'No suggested prompts created yet. Click "Add Prompt" to create your first one!'
        }
      });
    } else {
      prompts.forEach((prompt, index) => {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${prompt.buttonText}*\n_${prompt.messageText.substring(0, 100)}${prompt.messageText.length > 100 ? '...' : ''}_`
          },
          accessory: {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Edit'
            },
            action_id: `edit_prompt_${prompt.id}`,
            value: prompt.id
          }
        });
        
        if (index < prompts.length - 1) {
          blocks.push({
            type: 'divider'
          });
        }
      });
    }
    
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'view_suggested_prompts',
        title: {
          type: 'plain_text',
          text: 'Suggested Prompts'
        },
        close: {
          type: 'plain_text',
          text: 'Close'
        },
        blocks: blocks
      }
    });
  } catch (error) {
    console.error('Error opening view prompts modal:', error);
  }
});

// Jira setup button handler
app.action('setup_jira_button', async ({ ack, body, client }) => {
  await ack();
  
  try {
    // Send a modal for Jira setup
    await client.views.open({
      trigger_id: body.trigger_id,
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
          },
          {
            type: 'input',
            block_id: 'jira_default_project',
            element: {
              type: 'plain_text_input',
              action_id: 'default_project',
              placeholder: {
                type: 'plain_text',
                text: 'BUGS'
              }
            },
            label: {
              type: 'plain_text',
              text: 'Default Project Key (e.g., BUGS, PROJ, DEV)'
            },
            hint: {
              type: 'plain_text',
              text: 'This will be used as the default project when creating tickets'
            }
          }
        ]
      }
    });
  } catch (error) {
    console.error('Error opening Jira setup modal:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Sorry, there was an error opening the setup form. Please try again.'
    });
  }
});

// Handle Jira setup modal submission
app.view('jira_setup', async ({ ack, body, view, client }) => {
  await ack();
  
  try {
    // Get team ID from the correct location
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    console.log('Jira setup - body.team:', body.team);
    console.log('Jira setup - body.user:', body.user);
    console.log('Jira setup - teamId:', teamId);
    const values = view.state.values;
    
    const credentials = {
      baseUrl: values.jira_url.url.value,
      username: values.jira_username.username.value,
      apiToken: values.jira_token.token.value,
      defaultProject: values.jira_default_project.default_project.value
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

// Add suggested prompt modal submission handler
app.view('add_suggested_prompt', async ({ ack, body, view, client }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    const values = view.state.values;
    
    const buttonText = values.prompt_button_text.button_text.value;
    const messageText = values.prompt_message.message_text.value;
    
    if (!buttonText || !messageText) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Both button text and message text are required. Please try again.'
      });
      return;
    }
    
    const promptData = {
      buttonText: buttonText.trim(),
      messageText: messageText.trim(),
      enabled: true
    };
    
    const promptId = await redisService.saveSuggestedPrompt(teamId, promptData);
    
    if (promptId) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: `✅ Suggested prompt "${buttonText}" created successfully! It will now appear as a button in the AI Assistant pane.`
      });
    } else {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Failed to save suggested prompt. Please try again.'
      });
    }
  } catch (error) {
    console.error('Error processing suggested prompt creation:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Sorry, there was an error creating the suggested prompt. Please try again.'
    });
  }
});

// Edit suggested prompt action handler
app.action(/^edit_prompt_(.+)$/, async ({ ack, body, client, action }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    const promptId = action.value;
    const prompt = await redisService.getSuggestedPrompt(teamId, promptId);
    
    if (!prompt) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Prompt not found. It may have been deleted.'
      });
      return;
    }
    
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'edit_suggested_prompt',
        title: {
          type: 'plain_text',
          text: 'Edit Suggested Prompt'
        },
        submit: {
          type: 'plain_text',
          text: 'Update Prompt'
        },
        close: {
          type: 'plain_text',
          text: 'Cancel'
        },
        private_metadata: promptId,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'Edit your suggested prompt:'
            }
          },
          {
            type: 'input',
            block_id: 'prompt_button_text',
            element: {
              type: 'plain_text_input',
              action_id: 'button_text',
              placeholder: {
                type: 'plain_text',
                text: 'e.g., "Create a bug report"'
              },
              max_length: 75,
              initial_value: prompt.buttonText
            },
            label: {
              type: 'plain_text',
              text: 'Button Text'
            }
          },
          {
            type: 'input',
            block_id: 'prompt_message',
            element: {
              type: 'plain_text_input',
              action_id: 'message_text',
              multiline: true,
              placeholder: {
                type: 'plain_text',
                text: 'e.g., "Create a Jira ticket for a bug report with the following details: [describe the issue]"'
              },
              max_length: 2000,
              initial_value: prompt.messageText
            },
            label: {
              type: 'plain_text',
              text: 'Message to Send'
            }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '🗑️ Delete Prompt'
                },
                action_id: 'delete_prompt_button',
                style: 'danger',
                value: promptId
              }
            ]
          }
        ]
      }
    });
  } catch (error) {
    console.error('Error opening edit prompt modal:', error);
  }
});

// Edit suggested prompt modal submission handler
app.view('edit_suggested_prompt', async ({ ack, body, view, client }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    const promptId = view.private_metadata;
    const values = view.state.values;
    
    const buttonText = values.prompt_button_text.button_text.value;
    const messageText = values.prompt_message.message_text.value;
    
    if (!buttonText || !messageText) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Both button text and message text are required. Please try again.'
      });
      return;
    }
    
    const updates = {
      buttonText: buttonText.trim(),
      messageText: messageText.trim()
    };
    
    const success = await redisService.updateSuggestedPrompt(teamId, promptId, updates);
    
    if (success) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: `✅ Suggested prompt "${buttonText}" updated successfully!`
      });
    } else {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Failed to update suggested prompt. Please try again.'
      });
    }
  } catch (error) {
    console.error('Error processing suggested prompt update:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Sorry, there was an error updating the suggested prompt. Please try again.'
    });
  }
});

// Delete suggested prompt action handler
app.action('delete_prompt_button', async ({ ack, body, client, action }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    const promptId = action.value;
    
    const success = await redisService.deleteSuggestedPrompt(teamId, promptId);
    
    if (success) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '✅ Suggested prompt deleted successfully!'
      });
    } else {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Failed to delete suggested prompt. Please try again.'
      });
    }
  } catch (error) {
    console.error('Error deleting suggested prompt:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Sorry, there was an error deleting the suggested prompt. Please try again.'
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
    // Connect to Redis (with fallback to mock)
    await redisService.connect();
    if (redisService.isMock) {
      console.log('⚠️ Using mock Redis - integration features will be limited');
    } else {
      console.log('✅ Redis connected successfully');
    }

    await app.start();
    console.log('⚡️ Slack AI Assistant is running!');
    console.log('Environment check:');
    console.log('- SLACK_BOT_TOKEN:', process.env.SLACK_BOT_TOKEN ? 'Set' : 'Missing');
    console.log('- SLACK_SIGNING_SECRET:', process.env.SLACK_SIGNING_SECRET ? 'Set' : 'Missing');
    console.log('- XAI_API_KEY:', process.env.XAI_API_KEY ? 'Set' : 'Missing');
    console.log('- REDIS_URL:', process.env.REDIS_URL ? 'Set' : 'Missing');
    console.log('- PORT:', process.env.PORT || 3000);

    // Graceful shutdown handling
    const shutdown = async (signal) => {
      try {
        console.log(`[shutdown] signal=${signal} — closing Redis connection...`);
        await redisService.quit();
      } catch (e) {
        console.error('[shutdown] Redis quit error', e);
      }
      try {
        await app.stop?.();
      } catch (e) {
        console.error('[shutdown] App stop error', e);
      }
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    console.error('Failed to start the app:', error);
    process.exit(1);
  }
})();
