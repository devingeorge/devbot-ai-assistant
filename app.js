const { App } = require('@slack/bolt');
const axios = require('axios');
const redisService = require('./services/redisService');
const integrationService = require('./services/integrationService');
const salesforceService = require('./services/salesforceService');
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

// Helper function to check for key-phrase response matches
async function checkKeyPhraseResponse(message, teamId) {
  try {
    const responses = await redisService.getAllKeyPhraseResponses(teamId);
    const enabledResponses = responses.filter(r => r.enabled !== false);
    
    for (const response of enabledResponses) {
      const trigger = response.triggerPhrase.toLowerCase();
      const messageText = message.toLowerCase();
      
      // Check for exact match
      if (messageText === trigger) {
        return response;
      }
      
      // Check for wildcard match (starts with)
      if (trigger.endsWith('*')) {
        const prefix = trigger.slice(0, -1); // Remove the *
        if (messageText.startsWith(prefix)) {
          return response;
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error checking key-phrase responses:', error);
    return null;
  }
}

// Helper function to check for channel auto-response matches
async function checkChannelAutoResponse(channelId, teamId) {
  try {
    console.log('checkChannelAutoResponse called with:', { channelId, teamId });
    const responses = await redisService.getAllChannelAutoResponses(teamId);
    console.log('All channel auto-responses for team:', responses);
    
    const enabledResponses = responses.filter(r => r.enabled !== false);
    console.log('Enabled channel auto-responses:', enabledResponses);
    
    for (const response of enabledResponses) {
      console.log('Checking response:', response, 'against channel:', channelId);
      // Check if channel matches (supports both channel ID and channel name)
      if (response.channelId === channelId || 
          response.channelId === `#${channelId}` ||
          response.channelId.startsWith('C') && response.channelId === channelId) {
        console.log('Channel match found!', response);
        return response;
      }
    }
    
    console.log('No channel auto-response match found for channel:', channelId);
    return null;
  } catch (error) {
    console.error('Error checking channel auto-responses:', error);
    return null;
  }
}

// Helper function to validate Block Kit structure
function validateBlockKitStructure(blocks) {
  if (!Array.isArray(blocks)) {
    return { valid: false, error: 'Block Kit must be an array of blocks' };
  }
  
  if (blocks.length === 0) {
    return { valid: false, error: 'Block Kit array cannot be empty' };
  }
  
  if (blocks.length > 50) {
    return { valid: false, error: 'Block Kit cannot have more than 50 blocks' };
  }
  
  const validBlockTypes = [
    'section', 'divider', 'image', 'actions', 'context', 'input', 
    'file', 'header', 'video', 'rich_text', 'call', 'workflow_step'
  ];
  
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    
    if (!block.type) {
      return { valid: false, error: `Block ${i + 1} is missing required 'type' field` };
    }
    
    if (!validBlockTypes.includes(block.type)) {
      return { valid: false, error: `Block ${i + 1} has invalid type '${block.type}'. Valid types: ${validBlockTypes.join(', ')}` };
    }
    
    // Basic validation for common block types
    if (block.type === 'section' && !block.text && !block.fields && !block.accessory) {
      return { valid: false, error: `Section block ${i + 1} must have at least one of: text, fields, or accessory` };
    }
    
    if (block.type === 'header' && !block.text) {
      return { valid: false, error: `Header block ${i + 1} must have 'text' field` };
    }
    
    if (block.type === 'actions' && (!block.elements || !Array.isArray(block.elements))) {
      return { valid: false, error: `Actions block ${i + 1} must have 'elements' array` };
    }
  }
  
  return { valid: true };
}

// Helper function to send response (handles both plain text and Block Kit)
async function sendKeyPhraseResponse(client, channel, responseText, threadTs = null) {
  try {
    // Try to parse as Block Kit JSON
    try {
      const parsed = JSON.parse(responseText);
      
      // Check if it's a valid Block Kit structure
      if (Array.isArray(parsed)) {
        const validation = validateBlockKitStructure(parsed);
        
        if (validation.valid) {
          // It's valid Block Kit JSON
          await client.chat.postMessage({
            channel: channel,
            text: 'Response',
            blocks: parsed,
            thread_ts: threadTs
          });
          return;
        } else {
          // Invalid Block Kit structure, send error message
          await client.chat.postMessage({
            channel: channel,
            text: `❌ Invalid Block Kit structure: ${validation.error}\n\nFalling back to plain text response.`,
            thread_ts: threadTs
          });
          
          // Still send the original text as fallback
          await client.chat.postMessage({
            channel: channel,
            text: responseText,
            thread_ts: threadTs
          });
          return;
        }
      } else if (parsed && typeof parsed === 'object' && parsed.blocks && Array.isArray(parsed.blocks)) {
        // Handle case where user wraps blocks in an object with 'blocks' property
        const validation = validateBlockKitStructure(parsed.blocks);
        
        if (validation.valid) {
          await client.chat.postMessage({
            channel: channel,
            text: parsed.text || 'Response',
            blocks: parsed.blocks,
            thread_ts: threadTs
          });
          return;
        } else {
          await client.chat.postMessage({
            channel: channel,
            text: `❌ Invalid Block Kit structure: ${validation.error}\n\nFalling back to plain text response.`,
            thread_ts: threadTs
          });
          
          await client.chat.postMessage({
            channel: channel,
            text: responseText,
            thread_ts: threadTs
          });
          return;
        }
      }
    } catch (parseError) {
      // Not valid JSON, treat as plain text
    }
    
    // Send as plain text
    await client.chat.postMessage({
      channel: channel,
      text: responseText,
      thread_ts: threadTs
    });
  } catch (error) {
    console.error('Error sending key-phrase response:', error);
    // Fallback to plain text
    await client.chat.postMessage({
      channel: channel,
      text: responseText,
      thread_ts: threadTs
    });
  }
}

// Handle Salesforce requests with automatic token refresh
async function handleSalesforceRequest(message, tokens, userId, conversationHistory = []) {
  try {
    const lowerMessage = message.toLowerCase();
    
    // Build full conversation context for better detection
    const fullConversation = conversationHistory.map(msg => msg.content).join(' ') + ' ' + message;
    const lowerFullConversation = fullConversation.toLowerCase();
    
    // Check for Lead creation - be more flexible with detection
    if (lowerMessage.includes('create lead') || 
        lowerMessage.includes('new lead') || 
        lowerMessage.includes('lead for') ||
        lowerMessage.includes('please create it') ||
        (lowerMessage.includes('lead') && lowerMessage.includes('salesforce')) ||
        lowerFullConversation.includes('create a lead')) {
      
      const leadData = extractLeadData(fullConversation);
      console.log('Creating lead with data:', leadData);
      
      // Try to create lead with automatic token refresh
      const result = await createLeadWithRefresh(leadData, tokens, userId);
      
      if (result.success) {
        return `✅ Lead created successfully!\n\n**Lead ID:** ${result.id}\n**Link:** ${result.url}\n\nIs there anything else I can help you with?`;
      } else {
        return `❌ Failed to create lead: ${result.error}`;
      }
    }
    
    // Check for Opportunity creation
    if (lowerMessage.includes('create opportunity') || lowerMessage.includes('new opportunity')) {
      const opportunityData = extractOpportunityData(message);
      const result = await salesforceService.createOpportunity(opportunityData, tokens.access_token);
      
      if (result.success) {
        return `✅ Opportunity created successfully!\n\n**Opportunity ID:** ${result.id}\n**Link:** ${result.url}\n\nIs there anything else I can help you with?`;
      } else {
        return `❌ Failed to create opportunity: ${result.error}`;
      }
    }
    
    // Check for Account creation
    if (lowerMessage.includes('create account') || lowerMessage.includes('new account')) {
      const accountData = extractAccountData(message);
      const result = await salesforceService.createAccount(accountData, tokens.access_token);
      
      if (result.success) {
        return `✅ Account created successfully!\n\n**Account ID:** ${result.id}\n**Link:** ${result.url}\n\nIs there anything else I can help you with?`;
      } else {
        return `❌ Failed to create account: ${result.error}`;
      }
    }
    
    // Check for Case creation
    if (lowerMessage.includes('create case') || lowerMessage.includes('new case')) {
      const caseData = extractCaseData(message);
      const result = await salesforceService.createCase(caseData, tokens.access_token);
      
      if (result.success) {
        return `✅ Case created successfully!\n\n**Case ID:** ${result.id}\n**Link:** ${result.url}\n\nIs there anything else I can help you with?`;
      } else {
        return `❌ Failed to create case: ${result.error}`;
      }
    }
    
    // Check for Task creation
    if (lowerMessage.includes('create task') || lowerMessage.includes('new task')) {
      const taskData = extractTaskData(message);
      const result = await salesforceService.createTask(taskData, tokens.access_token);
      
      if (result.success) {
        return `✅ Task created successfully!\n\n**Task ID:** ${result.id}\n**Link:** ${result.url}\n\nIs there anything else I can help you with?`;
      } else {
        return `❌ Failed to create task: ${result.error}`;
      }
    }
    
    return null; // No Salesforce operation detected
  } catch (error) {
    console.error('Error handling Salesforce request:', error);
    return `❌ Salesforce operation failed: ${error.message}`;
  }
}

// Create lead with automatic token refresh
async function createLeadWithRefresh(leadData, tokens, userId) {
  try {
    // First attempt with current access token
    let result = await salesforceService.createLead(leadData, tokens.access_token);
    
    // If successful, return result
    if (result.success) {
      return result;
    }
    
    // If failed due to invalid session and we have a refresh token, try to refresh
    if (result.error && result.error.includes('INVALID_SESSION_ID') && tokens.refresh_token) {
      console.log('Access token expired, attempting to refresh...');
      
      try {
        // Refresh the token
        const refreshedTokens = await salesforceService.refreshToken(
          tokens.refresh_token,
          process.env.SALESFORCE_CLIENT_ID,
          process.env.SALESFORCE_CLIENT_SECRET
        );
        
        // Update tokens in Redis
        const teamId = tokens.teamId || 'unknown';
        const updatedTokens = {
          ...tokens,
          access_token: refreshedTokens.access_token,
          refresh_token: refreshedTokens.refresh_token || tokens.refresh_token,
          instance_url: refreshedTokens.instance_url || tokens.instance_url,
          updatedAt: new Date().toISOString()
        };
        
        await redisService.saveSalesforceTokens(teamId, userId, updatedTokens);
        console.log('Tokens refreshed and saved successfully');
        
        // Retry the lead creation with new token
        result = await salesforceService.createLead(leadData, refreshedTokens.access_token);
        
        if (result.success) {
          console.log('Lead created successfully after token refresh');
          return result;
        }
      } catch (refreshError) {
        console.error('Token refresh failed:', refreshError);
        return {
          success: false,
          error: 'Token expired and refresh failed. Please reconnect your Salesforce integration.'
        };
      }
    }
    
    return result;
  } catch (error) {
    console.error('Error in createLeadWithRefresh:', error);
    return {
      success: false,
      error: error.message || 'Unknown error occurred'
    };
  }
}

// Extract lead data from message
function extractLeadData(message) {
  const leadData = {
    LastName: 'Lead from Slack',
    Company: 'Unknown Company',
    Status: 'Open - Not Contacted'
  };
  
  // Try to extract contact name (look for "for [Name]" pattern)
  const nameMatch = message.match(/for\s+([A-Za-z\s]+?)(?:\s+in\s+Salesforce|\s+with\s+email|\s+is\s+his|\s+is\s+her|$)/i);
  if (nameMatch) {
    const fullName = nameMatch[1].trim();
    const nameParts = fullName.split(' ');
    if (nameParts.length >= 2) {
      leadData.FirstName = nameParts[0];
      leadData.LastName = nameParts.slice(1).join(' ');
    } else {
      leadData.LastName = fullName;
    }
  }
  
  // Try to extract email address
  const emailMatch = message.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
  if (emailMatch) {
    leadData.Email = emailMatch[1];
  }
  
  // Try to extract company name
  const companyMatch = message.match(/(?:company|at|for)\s+([A-Za-z0-9\s&.,-]+?)(?:\s+with\s+email|\s+is\s+his|\s+is\s+her|$)/i);
  if (companyMatch) {
    leadData.Company = companyMatch[1].trim();
  }
  
  return leadData;
}

// Extract opportunity data from message
function extractOpportunityData(message) {
  const opportunityData = {
    Name: 'Opportunity from Slack',
    StageName: 'Prospecting',
    CloseDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] // 30 days from now
  };
  
  // Try to extract opportunity name
  const nameMatch = message.match(/(?:opportunity|deal)\s+(?:for|about)\s+([A-Za-z0-9\s&.,-]+)/i);
  if (nameMatch) {
    opportunityData.Name = nameMatch[1].trim();
  }
  
  // Try to extract amount
  const amountMatch = message.match(/\$?([0-9,]+(?:\.[0-9]{2})?)\s*(?:k|thousand|million)?/i);
  if (amountMatch) {
    let amount = parseFloat(amountMatch[1].replace(/,/g, ''));
    if (message.toLowerCase().includes('k') || message.toLowerCase().includes('thousand')) {
      amount *= 1000;
    } else if (message.toLowerCase().includes('million')) {
      amount *= 1000000;
    }
    opportunityData.Amount = amount;
  }
  
  return opportunityData;
}

// Extract account data from message
function extractAccountData(message) {
  const accountData = {
    Name: 'Account from Slack',
    Type: 'Customer'
  };
  
  // Try to extract account name
  const nameMatch = message.match(/(?:account|company)\s+(?:for|named)\s+([A-Za-z0-9\s&.,-]+)/i);
  if (nameMatch) {
    accountData.Name = nameMatch[1].trim();
  }
  
  return accountData;
}

// Extract case data from message
function extractCaseData(message) {
  const caseData = {
    Subject: 'Case from Slack',
    Status: 'New',
    Priority: 'Medium'
  };
  
  // Try to extract case subject
  const subjectMatch = message.match(/(?:case|issue|problem)\s+(?:about|for)\s+([A-Za-z0-9\s&.,-]+)/i);
  if (subjectMatch) {
    caseData.Subject = subjectMatch[1].trim();
  }
  
  return caseData;
}

// Extract task data from message
function extractTaskData(message) {
  const taskData = {
    Subject: 'Task from Slack',
    Status: 'Not Started',
    Priority: 'Normal'
  };
  
  // Try to extract task subject
  const subjectMatch = message.match(/(?:task|reminder|follow-up)\s+(?:to|about|for)\s+([A-Za-z0-9\s&.,-]+)/i);
  if (subjectMatch) {
    taskData.Subject = subjectMatch[1].trim();
  }
  
  return taskData;
}

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
    
    // Check if this is a Salesforce request
    const salesforceTokens = await redisService.getSalesforceTokens(teamId, userId);
    if (salesforceTokens) {
      console.log('Salesforce tokens found for user:', userId);
      
      // Set the Salesforce instance URL
      salesforceService.setInstanceUrl(salesforceTokens.instance_url);
      
      // Check for Salesforce operations - pass conversation history for context
      const salesforceResult = await handleSalesforceRequest(message, salesforceTokens, userId, conversationHistory);
      if (salesforceResult) {
        return salesforceResult;
      }
    }
    
    // Get user-specific system prompt configuration
    let userSystemPrompt = null;
    if (teamId && userId) {
      userSystemPrompt = await redisService.getUserSystemPrompt(teamId, userId);
    }
    
    // Build system prompt with integration capabilities and user preferences
    let systemPrompt = 'You are a helpful AI assistant integrated into Slack. Be concise and helpful in your responses. Maintain context from previous messages in the conversation.';
    
    // Add user-specific behavior settings
    if (userSystemPrompt) {
      systemPrompt += `\n\nUser-specific behavior settings:`;
      systemPrompt += `\n- Response tone: ${userSystemPrompt.tone}`;
      systemPrompt += `\n- Business context: ${userSystemPrompt.businessType}`;
      
      if (userSystemPrompt.companyName) {
        systemPrompt += `\n- Company: ${userSystemPrompt.companyName}`;
      }
      
      if (userSystemPrompt.additionalDirections) {
        systemPrompt += `\n- Additional directions: ${userSystemPrompt.additionalDirections}`;
      }
    }
    
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

    // Show typing indicator (with fallback)
    try {
      await client.conversations.mark({
        channel: event.channel,
        ts: event.ts
      });
    } catch (markError) {
      console.log('Could not mark conversation as read:', markError.message);
      // Continue without marking - not critical
    }

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
    
    // Debug missing scopes
    if (error.data && error.data.response_metadata) {
      console.error('Missing scopes:', error.data.response_metadata.scopes);
      console.error('Accepted scopes:', error.data.response_metadata.acceptedScopes);
    }
    
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
app.event('assistant_thread_started', async ({ event, client, context }) => {
  try {
    console.log('AI Assistant thread started:', event);
    
    // Get channel ID from assistant_thread object
    const channelId = event.assistant_thread?.channel_id;
    if (!channelId) {
      console.log('No channel information in assistant_thread_started event');
      return;
    }
    
    // Get team ID from the event context - try multiple sources
    const teamId = event.team || event.assistant_thread?.team_id || context?.teamId || 'unknown';
    console.log('Event team:', event.team);
    console.log('Assistant thread team_id:', event.assistant_thread?.team_id);
    console.log('Context teamId:', context?.teamId);
    console.log('Final teamId:', teamId);
    
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
          message: prompt.messageText
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
    
    // Get user-specific welcome message
    const userId = event.assistant_thread?.user_id;
    let welcomeMessage = 'Hello! How can I help you today?'; // Default message
    
    if (userId && teamId !== 'unknown') {
      const userSystemPrompt = await redisService.getUserSystemPrompt(teamId, userId);
      if (userSystemPrompt?.welcomeMessage) {
        welcomeMessage = userSystemPrompt.welcomeMessage;
      }
    }
    
    // Post a welcome message in the AI Assistant thread
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: event.assistant_thread.thread_ts,
      text: welcomeMessage
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
  console.log('=== MESSAGE EVENT RECEIVED ===');
  console.log('Event details:', {
    type: event.type,
    channel: event.channel,
    channel_type: event.channel_type,
    user: event.user,
    text: event.text,
    bot_id: event.bot_id,
    subtype: event.subtype,
    team: event.team
  });
  console.log('Context:', context);
  
  // Skip messages from bots (including ourselves)
  if (event.bot_id || event.subtype) {
    console.log('Skipping bot message or message with subtype');
    return;
  }

  // Handle AI Assistant messages (channel type 'im' and has thread_ts)
  if (event.channel_type === 'im' && event.thread_ts) {
    try {
      console.log('Processing AI Assistant message:', event);
      
      // Check for key-phrase response matches first
      const teamId = context.teamId;
      if (teamId) {
        const keyPhraseResponse = await checkKeyPhraseResponse(event.text, teamId);
        if (keyPhraseResponse) {
          console.log('Key-phrase response matched:', keyPhraseResponse.triggerPhrase);
          await sendKeyPhraseResponse(client, event.channel, keyPhraseResponse.responseText, event.thread_ts);
          return; // Skip AI processing
        }
      }
      
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
  // Handle channel messages (not DMs)
  else if (event.channel_type !== 'im') {
    try {
      console.log('Processing channel message:', event);
      console.log('Channel message details:', {
        channel: event.channel,
        channel_type: event.channel_type,
        team: event.team,
        user: event.user,
        text: event.text
      });
      
      // Check for channel auto-response matches
      const teamId = context.teamId;
      console.log('Team ID for channel message:', teamId);
      
      if (teamId) {
        console.log('Checking for channel auto-response in channel:', event.channel, 'for team:', teamId);
        
        // Check if bot is in the channel
        try {
          const channelInfo = await client.conversations.info({
            channel: event.channel
          });
          console.log('Channel info:', {
            name: channelInfo.channel.name,
            is_member: channelInfo.channel.is_member,
            is_private: channelInfo.channel.is_private
          });
        } catch (channelError) {
          console.error('Error getting channel info:', channelError);
        }
        
        const channelAutoResponse = await checkChannelAutoResponse(event.channel, teamId);
        console.log('Channel auto-response result:', channelAutoResponse);
        
        if (channelAutoResponse) {
          console.log('Channel auto-response matched:', channelAutoResponse.channelId);
          
          // Show typing indicator
          await client.conversations.mark({
            channel: event.channel,
            ts: event.ts
          });
          
          // Get AI response from GROK
          const aiResponse = await callGrokAPI(event.text, event.user, [], teamId);
          
          // Reply in thread
          await client.chat.postMessage({
            channel: event.channel,
            text: aiResponse,
            thread_ts: event.ts
          });
          return; // Skip further processing
        }
      }
    } catch (error) {
      console.error('Error processing channel message:', error);
      
      // Debug missing scopes
      if (error.data && error.data.response_metadata) {
        console.error('Missing scopes:', error.data.response_metadata.scopes);
        console.error('Accepted scopes:', error.data.response_metadata.acceptedScopes);
      }
    }
  }
  // Handle regular DM messages (no thread_ts)
  else if (event.channel_type === 'im' && !event.thread_ts) {
    try {
      // Check for key-phrase response matches first
      const teamId = context.teamId;
      if (teamId) {
        const keyPhraseResponse = await checkKeyPhraseResponse(event.text, teamId);
        if (keyPhraseResponse) {
          console.log('Key-phrase response matched:', keyPhraseResponse.triggerPhrase);
          await sendKeyPhraseResponse(client, event.channel, keyPhraseResponse.responseText);
          return; // Skip AI processing
        }
      }
      
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
      
      // Debug missing scopes
      if (error.data && error.data.response_metadata) {
        console.error('Missing scopes:', error.data.response_metadata.scopes);
        console.error('Accepted scopes:', error.data.response_metadata.acceptedScopes);
      }
      
      await say('Sorry, I encountered an error processing your request. Please try again.');
    }
  }
});

// Home tab handler
app.event('app_home_opened', async ({ event, client }) => {
  try {
    // Check if we have valid tokens before trying to publish
    const teamId = event.team;
    if (!teamId) {
      console.log('No team ID found in app_home_opened event, skipping home view publish');
      return;
    }

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
              text: '*Salesforce Integration:*\nConnect your Salesforce org'
            },
            accessory: {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '🔗 Connect'
              },
              action_id: 'connect_salesforce_button',
              value: 'connect_salesforce'
            }
          },
          {
            type: 'divider'
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*AI Behavior Settings:*\nCustomize how I respond to you'
            },
            accessory: {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '⚙️ Configure'
              },
              action_id: 'configure_system_prompt_button',
              value: 'configure_prompt'
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
              text: '*Key-Phrase Responses:*\nSet up automatic responses that bypass the AI for specific phrases:'
            }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '➕ Add Response'
                },
                action_id: 'add_key_phrase_response_button',
                style: 'primary'
              },
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '📋 View Responses'
                },
                action_id: 'view_key_phrase_responses_button'
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
              text: '*Channel Auto-Responses:*\nSet up automatic responses in specific channels (responds in threads):'
            }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '➕ Add Channel Response'
                },
                action_id: 'add_channel_auto_response_button',
                style: 'primary'
              },
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '📋 View Channel Responses'
                },
                action_id: 'view_channel_auto_responses_button'
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
                  text: '🧹 Clean Chat History'
                },
                action_id: 'clean_chat_history_button',
                style: 'danger'
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

// Clean chat history button handler
app.action('clean_chat_history_button', async ({ ack, body, client }) => {
  await ack();
  
  try {
    // This only clears conversation history in Slack, not Redis data
    // We'll send a message to the user's DM channel to clear the conversation
    await client.chat.postMessage({
      channel: body.user.id,
      text: '🧹 Chat history cleaned! Your conversation history has been cleared. This does not affect any saved integrations, prompts, or other data.',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '🧹 *Chat History Cleaned!*\n\nYour conversation history has been cleared. This does not affect any saved integrations, prompts, or other data.'
          }
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: '💡 Tip: You can start a fresh conversation anytime!'
            }
          ]
        }
      ]
    });
  } catch (error) {
    console.error('Error cleaning chat history:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: '❌ Sorry, there was an error cleaning the chat history. Please try again.'
    });
  }
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
    console.log('View prompts - teamId:', teamId);
    const prompts = await redisService.getAllSuggestedPrompts(teamId);
    console.log('View prompts - retrieved prompts:', prompts);
    
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
        const statusIcon = prompt.enabled === false ? '🔴' : '🟢';
        const statusText = prompt.enabled === false ? 'Disabled' : 'Enabled';
        
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${statusIcon} *${prompt.buttonText}* (${statusText})\n_${prompt.messageText.substring(0, 100)}${prompt.messageText.length > 100 ? '...' : ''}_`
          }
        });
        
        blocks.push({
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '✏️ Edit'
              },
              action_id: `edit_prompt_${prompt.id}`,
              value: prompt.id
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: prompt.enabled === false ? '✅ Enable' : '⏸️ Disable'
              },
              action_id: `toggle_prompt_${prompt.id}`,
              value: prompt.id,
              style: prompt.enabled === false ? 'primary' : undefined
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '🗑️ Delete'
              },
              action_id: `delete_prompt_${prompt.id}`,
              value: prompt.id,
              style: 'danger'
            }
          ]
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
    console.error('Full error details:', error.response?.data || error.message);
    
    // Send error message to user
    await client.chat.postMessage({
      channel: body.user.id,
      text: `❌ Error opening prompts view: ${error.message || 'Unknown error'}`
    });
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

// Helper function to get view prompts blocks
async function getViewPromptsBlocks(teamId) {
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
      const statusIcon = prompt.enabled === false ? '🔴' : '🟢';
      const statusText = prompt.enabled === false ? 'Disabled' : 'Enabled';
      
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${statusIcon} *${prompt.buttonText}* (${statusText})\n_${prompt.messageText.substring(0, 100)}${prompt.messageText.length > 100 ? '...' : ''}_`
        }
      });
      
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '✏️ Edit'
            },
            action_id: `edit_prompt_${prompt.id}`,
            value: prompt.id
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: prompt.enabled === false ? '✅ Enable' : '⏸️ Disable'
            },
            action_id: `toggle_prompt_${prompt.id}`,
            value: prompt.id,
            style: prompt.enabled === false ? 'primary' : undefined
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '🗑️ Delete'
            },
            action_id: `delete_prompt_${prompt.id}`,
            value: prompt.id,
            style: 'danger'
          }
        ]
      });
      
      if (index < prompts.length - 1) {
        blocks.push({
          type: 'divider'
        });
      }
    });
  }
  
  return blocks;
}

// Helper function to update the view prompts modal
async function updateViewPromptsModal(client, body, teamId) {
  try {
    const blocks = await getViewPromptsBlocks(teamId);
    
    await client.views.update({
      view_id: body.view.id,
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
    console.error('Error updating view prompts modal:', error);
  }
}

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
    
    await client.views.push({
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
      // Get the root view_id (the original "View Prompts" modal)
      const rootViewId = body.view.root_view_id || body.view.id;
      
      // Wait a moment for the edit modal to close and return to the original modal
      setTimeout(async () => {
        try {
          const blocks = await getViewPromptsBlocks(teamId);
          await client.views.update({
            view_id: rootViewId,
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
          console.error('Error updating modal after edit:', error);
        }
      }, 500); // Small delay to ensure the edit modal has closed
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

// Toggle suggested prompt enabled/disabled action handler
app.action(/^toggle_prompt_(.+)$/, async ({ ack, body, client, action }) => {
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
    
    const newEnabled = !prompt.enabled;
    const success = await redisService.updateSuggestedPrompt(teamId, promptId, { enabled: newEnabled });
    
    if (success) {
      // Update the modal view to reflect the new status
      await updateViewPromptsModal(client, body, teamId);
    } else {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Failed to update prompt status. Please try again.'
      });
    }
  } catch (error) {
    console.error('Error toggling prompt:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Sorry, there was an error updating the prompt. Please try again.'
    });
  }
});

// Delete suggested prompt action handler
app.action(/^delete_prompt_(.+)$/, async ({ ack, body, client, action }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    const promptId = action.value;
    
    const success = await redisService.deleteSuggestedPrompt(teamId, promptId);
    
    if (success) {
      // Update the modal view to reflect the deletion
      await updateViewPromptsModal(client, body, teamId);
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

// Add key-phrase response button handler
app.action('add_key_phrase_response_button', async ({ ack, body, client }) => {
  await ack();
  
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'add_key_phrase_response',
        title: {
          type: 'plain_text',
          text: 'Add Key-Phrase Response'
        },
        submit: {
          type: 'plain_text',
          text: 'Add Response'
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
              text: 'Create a key-phrase response that will automatically trigger without using the AI:'
            }
          },
          {
            type: 'input',
            block_id: 'trigger_phrase',
            element: {
              type: 'plain_text_input',
              action_id: 'trigger_text',
              placeholder: {
                type: 'plain_text',
                text: 'e.g., "how are you" or "hey*" (use * for wildcard)'
              },
              max_length: 100
            },
            label: {
              type: 'plain_text',
              text: 'Trigger Phrase'
            }
          },
          {
            type: 'input',
            block_id: 'response_text',
            element: {
              type: 'plain_text_input',
              action_id: 'response_text',
              multiline: true,
              placeholder: {
                type: 'plain_text',
                text: 'Plain text: "Great! How are you!"\n\nBlock Kit JSON:\n[{"type":"section","text":{"type":"mrkdwn","text":"*Hello!* :wave:"}}]'
              },
              max_length: 2000
            },
            label: {
              type: 'plain_text',
              text: 'Response (Plain Text or Block Kit JSON)'
            }
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: '💡 Use * for wildcards (e.g., "hey*" matches "hey there", "hey buddy", etc.)'
              }
            ]
          }
        ]
      }
    });
  } catch (error) {
    console.error('Error opening add key-phrase response modal:', error);
  }
});

// Add key-phrase response modal submission handler
app.view('add_key_phrase_response', async ({ ack, body, view, client }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    const values = view.state.values;
    
    const triggerPhrase = values.trigger_phrase.trigger_text.value;
    const responseText = values.response_text.response_text.value;
    
    if (!triggerPhrase || !responseText) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Both trigger phrase and response are required. Please try again.'
      });
      return;
    }
    
    const responseData = {
      triggerPhrase: triggerPhrase.trim(),
      responseText: responseText.trim(),
      enabled: true
    };
    
    const responseId = await redisService.saveKeyPhraseResponse(teamId, responseData);
    
    if (responseId) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: `✅ Key-phrase response "${triggerPhrase}" added successfully!`
      });
    } else {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Failed to save key-phrase response. Please try again.'
      });
    }
  } catch (error) {
    console.error('Error processing key-phrase response:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Sorry, there was an error creating the key-phrase response. Please try again.'
    });
  }
});

// Helper function to get view key-phrase responses blocks
async function getViewKeyPhraseResponsesBlocks(teamId) {
  const responses = await redisService.getAllKeyPhraseResponses(teamId);
  
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Key-Phrase Responses* (${responses.length} total)`
      }
    },
    {
      type: 'divider'
    }
  ];
  
  if (responses.length === 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'No key-phrase responses created yet. Click "Add Response" to create your first one!'
      }
    });
  } else {
    responses.forEach((response, index) => {
      const statusIcon = response.enabled === false ? '🔴' : '🟢';
      const statusText = response.enabled === false ? 'Disabled' : 'Enabled';
      
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${statusIcon} *${response.triggerPhrase}* (${statusText})\n_${response.responseText.substring(0, 100)}${response.responseText.length > 100 ? '...' : ''}_`
        }
      });
      
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '✏️ Edit'
            },
            action_id: `edit_response_${response.id}`,
            value: response.id
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: response.enabled === false ? '✅ Enable' : '⏸️ Disable'
            },
            action_id: `toggle_response_${response.id}`,
            value: response.id,
            style: response.enabled === false ? 'primary' : undefined
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '🗑️ Delete'
            },
            action_id: `delete_response_${response.id}`,
            value: response.id,
            style: 'danger'
          }
        ]
      });
      
      if (index < responses.length - 1) {
        blocks.push({
          type: 'divider'
        });
      }
    });
  }
  
  return blocks;
}

// Helper function to update the view key-phrase responses modal
async function updateViewKeyPhraseResponsesModal(client, body, teamId) {
  try {
    const blocks = await getViewKeyPhraseResponsesBlocks(teamId);
    
    await client.views.update({
      view_id: body.view.id,
      view: {
        type: 'modal',
        callback_id: 'view_key_phrase_responses',
        title: {
          type: 'plain_text',
          text: 'Key-Phrase Responses'
        },
        close: {
          type: 'plain_text',
          text: 'Close'
        },
        blocks: blocks
      }
    });
  } catch (error) {
    console.error('Error updating view key-phrase responses modal:', error);
  }
}

// View key-phrase responses button handler
app.action('view_key_phrase_responses_button', async ({ ack, body, client }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    console.log('View key-phrase responses - teamId:', teamId);
    const blocks = await getViewKeyPhraseResponsesBlocks(teamId);
    
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'view_key_phrase_responses',
        title: {
          type: 'plain_text',
          text: 'Key-Phrase Responses'
        },
        close: {
          type: 'plain_text',
          text: 'Close'
        },
        blocks: blocks
      }
    });
  } catch (error) {
    console.error('Error opening view key-phrase responses modal:', error);
    console.error('Full error details:', error.response?.data || error.message);
    
    // Send error message to user
    await client.chat.postMessage({
      channel: body.user.id,
      text: `❌ Error opening responses view: ${error.message || 'Unknown error'}`
    });
  }
});

// Edit key-phrase response action handler
app.action(/^edit_response_(.+)$/, async ({ ack, body, client, action }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    const responseId = action.value;
    const response = await redisService.getKeyPhraseResponse(teamId, responseId);
    
    if (!response) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Response not found. It may have been deleted.'
      });
      return;
    }
    
    await client.views.push({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'edit_key_phrase_response',
        title: {
          type: 'plain_text',
          text: 'Edit Key-Phrase Response'
        },
        submit: {
          type: 'plain_text',
          text: 'Update Response'
        },
        close: {
          type: 'plain_text',
          text: 'Cancel'
        },
        private_metadata: responseId,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'Edit your key-phrase response:'
            }
          },
          {
            type: 'input',
            block_id: 'trigger_phrase',
            element: {
              type: 'plain_text_input',
              action_id: 'trigger_text',
              placeholder: {
                type: 'plain_text',
                text: 'e.g., "how are you" or "hey*" (use * for wildcard)'
              },
              max_length: 100,
              initial_value: response.triggerPhrase
            },
            label: {
              type: 'plain_text',
              text: 'Trigger Phrase'
            }
          },
          {
            type: 'input',
            block_id: 'response_text',
            element: {
              type: 'plain_text_input',
              action_id: 'response_text',
              multiline: true,
              placeholder: {
                type: 'plain_text',
                text: 'Plain text: "Great! How are you!"\n\nBlock Kit JSON:\n[{"type":"section","text":{"type":"mrkdwn","text":"*Hello!* :wave:"}}]'
              },
              max_length: 2000,
              initial_value: response.responseText
            },
            label: {
              type: 'plain_text',
              text: 'Response (Plain Text or Block Kit JSON)'
            }
          }
        ]
      }
    });
  } catch (error) {
    console.error('Error opening edit response modal:', error);
  }
});

// Edit key-phrase response modal submission handler
app.view('edit_key_phrase_response', async ({ ack, body, view, client }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    const responseId = view.private_metadata;
    const values = view.state.values;
    
    const triggerPhrase = values.trigger_phrase.trigger_text.value;
    const responseText = values.response_text.response_text.value;
    
    if (!triggerPhrase || !responseText) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Both trigger phrase and response are required. Please try again.'
      });
      return;
    }
    
    const updates = {
      triggerPhrase: triggerPhrase.trim(),
      responseText: responseText.trim()
    };
    
    const success = await redisService.updateKeyPhraseResponse(teamId, responseId, updates);
    
    if (success) {
      // Update the underlying view after a short delay to ensure the edit modal has closed
      setTimeout(async () => {
        try {
          await client.views.update({
            view_id: body.view.root_view_id,
            view: {
              type: 'modal',
              callback_id: 'view_key_phrase_responses',
              title: {
                type: 'plain_text',
                text: 'Key-Phrase Responses'
              },
              close: {
                type: 'plain_text',
                text: 'Close'
              },
              blocks: await getViewKeyPhraseResponsesBlocks(teamId)
            }
          });
        } catch (updateError) {
          console.error('Error updating view after edit:', updateError);
        }
      }, 500);
      
      await client.chat.postMessage({
        channel: body.user.id,
        text: `✅ Key-phrase response "${triggerPhrase}" updated successfully!`
      });
    } else {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Failed to update key-phrase response. Please try again.'
      });
    }
  } catch (error) {
    console.error('Error processing key-phrase response update:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Sorry, there was an error updating the key-phrase response. Please try again.'
    });
  }
});

// Toggle key-phrase response enabled/disabled action handler
app.action(/^toggle_response_(.+)$/, async ({ ack, body, client, action }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    const responseId = action.value;
    const response = await redisService.getKeyPhraseResponse(teamId, responseId);
    
    if (!response) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Response not found. It may have been deleted.'
      });
      return;
    }
    
    const newEnabled = !response.enabled;
    const success = await redisService.updateKeyPhraseResponse(teamId, responseId, { enabled: newEnabled });
    
    if (success) {
      // Update the modal to reflect the change
      await updateViewKeyPhraseResponsesModal(client, body, teamId);
      
      await client.chat.postMessage({
        channel: body.user.id,
        text: `✅ Response "${response.triggerPhrase}" ${newEnabled ? 'enabled' : 'disabled'} successfully!`
      });
    } else {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Failed to update response status. Please try again.'
      });
    }
  } catch (error) {
    console.error('Error toggling response:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Sorry, there was an error updating the response. Please try again.'
    });
  }
});

// Delete key-phrase response action handler
app.action(/^delete_response_(.+)$/, async ({ ack, body, client, action }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    const responseId = action.value;
    
    const success = await redisService.deleteKeyPhraseResponse(teamId, responseId);
    
    if (success) {
      // Update the modal to reflect the change
      await updateViewKeyPhraseResponsesModal(client, body, teamId);
      
      await client.chat.postMessage({
        channel: body.user.id,
        text: '✅ Key-phrase response deleted successfully!'
      });
    } else {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Failed to delete key-phrase response. Please try again.'
      });
    }
  } catch (error) {
    console.error('Error deleting key-phrase response:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Sorry, there was an error deleting the key-phrase response. Please try again.'
    });
  }
});

// Add channel auto-response button handler
app.action('add_channel_auto_response_button', async ({ ack, body, client }) => {
  await ack();
  
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'add_channel_auto_response',
        title: {
          type: 'plain_text',
          text: 'Add Channel Response'
        },
        submit: {
          type: 'plain_text',
          text: 'Create Response'
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
              text: 'Create an automatic response for a specific channel:'
            }
          },
          {
            type: 'input',
            block_id: 'channel_select',
            element: {
              type: 'channels_select',
              action_id: 'channel_select',
              placeholder: {
                type: 'plain_text',
                text: 'Select a channel'
              }
            },
            label: {
              type: 'plain_text',
              text: 'Channel'
            }
          }
        ]
      }
    });
  } catch (error) {
    console.error('Error opening add channel auto-response modal:', error);
  }
});

// Add channel auto-response modal submission handler
app.view('add_channel_auto_response', async ({ ack, body, view, client }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    const values = view.state.values;
    
    const channelId = values.channel_select.channel_select.selected_channel;
    
    if (!channelId) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Please select a channel. Please try again.'
      });
      return;
    }
    
    const responseData = {
      channelId: channelId,
      enabled: true
    };
    
    const responseId = await redisService.saveChannelAutoResponse(teamId, responseData);
    
    if (responseId) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: `✅ Channel auto-response created successfully!\n\nChannel: <#${channelId}> will now receive AI responses in threads.`
      });
    } else {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Failed to create channel auto-response. Please try again.'
      });
    }
  } catch (error) {
    console.error('Error processing channel auto-response creation:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Sorry, there was an error creating the channel auto-response. Please try again.'
    });
  }
});

// View channel auto-responses button handler
app.action('view_channel_auto_responses_button', async ({ ack, body, client }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    console.log('View channel auto-responses - teamId:', teamId);
    const responses = await redisService.getAllChannelAutoResponses(teamId);
    console.log('View channel auto-responses - retrieved responses:', responses);
    
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Channel Responses* (${responses.length} total)`
        }
      },
      {
        type: 'divider'
      }
    ];
    
    if (responses.length === 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'No channel auto-responses created yet. Click "Add Channel Response" to create your first one!'
        }
      });
    } else {
      responses.forEach((response, index) => {
        const statusIcon = response.enabled === false ? '🔴' : '🟢';
        const statusText = response.enabled === false ? 'Disabled' : 'Enabled';
        
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${statusIcon} *<#${response.channelId}>* (${statusText})\n_AI will respond in threads to messages in this channel_`
          }
        });
        
        blocks.push({
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '✏️ Edit'
              },
              action_id: `edit_channel_response_${response.id}`,
              value: response.id
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: response.enabled === false ? '✅ Enable' : '⏸️ Disable'
              },
              action_id: `toggle_channel_response_${response.id}`,
              value: response.id,
              style: response.enabled === false ? 'primary' : undefined
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '🗑️ Delete'
              },
              action_id: `delete_channel_response_${response.id}`,
              value: response.id,
              style: 'danger'
            }
          ]
        });
        
        if (index < responses.length - 1) {
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
        callback_id: 'view_channel_auto_responses',
        title: {
          type: 'plain_text',
          text: 'Channel Responses'
        },
        close: {
          type: 'plain_text',
          text: 'Close'
        },
        blocks: blocks
      }
    });
  } catch (error) {
    console.error('Error opening view channel auto-responses modal:', error);
    console.error('Full error details:', error.response?.data || error.message);
    
    // Send error message to user
    await client.chat.postMessage({
      channel: body.user.id,
      text: `❌ Error opening channel responses view: ${error.message || 'Unknown error'}`
    });
  }
});

// Edit channel auto-response action handler
app.action(/^edit_channel_response_(.+)$/, async ({ ack, body, client, action }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    const responseId = action.value;
    const response = await redisService.getChannelAutoResponse(teamId, responseId);
    
    if (!response) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Response not found. It may have been deleted.'
      });
      return;
    }
    
    await client.views.push({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'edit_channel_auto_response',
        title: {
          type: 'plain_text',
          text: 'Edit Channel Response'
        },
        submit: {
          type: 'plain_text',
          text: 'Update Response'
        },
        close: {
          type: 'plain_text',
          text: 'Cancel'
        },
        private_metadata: responseId,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'Edit your channel auto-response:'
            }
          },
          {
            type: 'input',
            block_id: 'channel_select',
            element: {
              type: 'channels_select',
              action_id: 'channel_select',
              placeholder: {
                type: 'plain_text',
                text: 'Select a channel'
              },
              initial_channel: response.channelId
            },
            label: {
              type: 'plain_text',
              text: 'Channel'
            }
          }
        ]
      }
    });
  } catch (error) {
    console.error('Error opening edit channel response modal:', error);
  }
});

// Edit channel auto-response modal submission handler
app.view('edit_channel_auto_response', async ({ ack, body, view, client }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    const responseId = view.private_metadata;
    const values = view.state.values;
    
    const channelId = values.channel_select.channel_select.selected_channel;
    
    if (!channelId) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Please select a channel. Please try again.'
      });
      return;
    }
    
    const updates = {
      channelId: channelId
    };
    
    const success = await redisService.updateChannelAutoResponse(teamId, responseId, updates);
    
    if (success) {
      // Update the underlying view after a short delay to ensure the edit modal has closed
      setTimeout(async () => {
        try {
          const responses = await redisService.getAllChannelAutoResponses(teamId);
          const blocks = [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Channel Responses* (${responses.length} total)`
              }
            },
            {
              type: 'divider'
            }
          ];
          
          if (responses.length === 0) {
            blocks.push({
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: 'No channel auto-responses created yet. Click "Add Channel Response" to create your first one!'
              }
            });
          } else {
            responses.forEach((response, index) => {
              const statusIcon = response.enabled === false ? '🔴' : '🟢';
              const statusText = response.enabled === false ? 'Disabled' : 'Enabled';
              
              blocks.push({
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `${statusIcon} *<#${response.channelId}>* (${statusText})\n_AI will respond in threads to messages in this channel_`
                }
              });
              
              blocks.push({
                type: 'actions',
                elements: [
                  {
                    type: 'button',
                    text: {
                      type: 'plain_text',
                      text: '✏️ Edit'
                    },
                    action_id: `edit_channel_response_${response.id}`,
                    value: response.id
                  },
                  {
                    type: 'button',
                    text: {
                      type: 'plain_text',
                      text: response.enabled === false ? '✅ Enable' : '⏸️ Disable'
                    },
                    action_id: `toggle_channel_response_${response.id}`,
                    value: response.id,
                    style: response.enabled === false ? 'primary' : undefined
                  },
                  {
                    type: 'button',
                    text: {
                      type: 'plain_text',
                      text: '🗑️ Delete'
                    },
                    action_id: `delete_channel_response_${response.id}`,
                    value: response.id,
                    style: 'danger'
                  }
                ]
              });
              
              if (index < responses.length - 1) {
                blocks.push({
                  type: 'divider'
                });
              }
            });
          }
          
          await client.views.update({
            view_id: body.view.root_view_id,
            view: {
              type: 'modal',
              callback_id: 'view_channel_auto_responses',
              title: {
                type: 'plain_text',
                text: 'Channel Responses'
              },
              close: {
                type: 'plain_text',
                text: 'Close'
              },
              blocks: blocks
            }
          });
        } catch (updateError) {
          console.error('Error updating view after edit:', updateError);
        }
      }, 500);
      
      await client.chat.postMessage({
        channel: body.user.id,
        text: `✅ Channel auto-response updated successfully!\n\nChannel: <#${channelId}> will now receive AI responses in threads.`
      });
    } else {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Failed to update channel auto-response. Please try again.'
      });
    }
  } catch (error) {
    console.error('Error processing channel auto-response update:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Sorry, there was an error updating the channel auto-response. Please try again.'
    });
  }
});

// Toggle channel auto-response enabled/disabled action handler
app.action(/^toggle_channel_response_(.+)$/, async ({ ack, body, client, action }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    const responseId = action.value;
    const response = await redisService.getChannelAutoResponse(teamId, responseId);
    
    if (!response) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Response not found. It may have been deleted.'
      });
      return;
    }
    
    const newEnabled = !response.enabled;
    const success = await redisService.updateChannelAutoResponse(teamId, responseId, { enabled: newEnabled });
    
    if (success) {
      // Update the modal to reflect the change
      const responses = await redisService.getAllChannelAutoResponses(teamId);
      const blocks = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Channel Responses* (${responses.length} total)`
          }
        },
        {
          type: 'divider'
        }
      ];
      
      if (responses.length === 0) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'No channel auto-responses created yet. Click "Add Channel Response" to create your first one!'
          }
        });
      } else {
        responses.forEach((response, index) => {
          const statusIcon = response.enabled === false ? '🔴' : '🟢';
          const statusText = response.enabled === false ? 'Disabled' : 'Enabled';
          
          blocks.push({
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${statusIcon} *${response.channelId}* (${statusText})\n_${response.responseText.substring(0, 100)}${response.responseText.length > 100 ? '...' : ''}_`
            }
          });
          
          blocks.push({
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '✏️ Edit'
                },
                action_id: `edit_channel_response_${response.id}`,
                value: response.id
              },
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: response.enabled === false ? '✅ Enable' : '⏸️ Disable'
                },
                action_id: `toggle_channel_response_${response.id}`,
                value: response.id,
                style: response.enabled === false ? 'primary' : undefined
              },
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '🗑️ Delete'
                },
                action_id: `delete_channel_response_${response.id}`,
                value: response.id,
                style: 'danger'
              }
            ]
          });
          
          if (index < responses.length - 1) {
            blocks.push({
              type: 'divider'
            });
          }
        });
      }
      
      await client.views.update({
        view_id: body.view.id,
        view: {
          type: 'modal',
          callback_id: 'view_channel_auto_responses',
          title: {
            type: 'plain_text',
            text: 'Channel Responses'
          },
          close: {
            type: 'plain_text',
            text: 'Close'
          },
          blocks: blocks
        }
      });
      
      await client.chat.postMessage({
        channel: body.user.id,
        text: `✅ Channel response "${response.channelId}" ${newEnabled ? 'enabled' : 'disabled'} successfully!`
      });
    } else {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Failed to update response status. Please try again.'
      });
    }
  } catch (error) {
    console.error('Error toggling channel response:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Sorry, there was an error updating the response. Please try again.'
    });
  }
});

// Delete channel auto-response action handler
app.action(/^delete_channel_response_(.+)$/, async ({ ack, body, client, action }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    const responseId = action.value;
    
    const success = await redisService.deleteChannelAutoResponse(teamId, responseId);
    
    if (success) {
      // Update the modal to reflect the change
      const responses = await redisService.getAllChannelAutoResponses(teamId);
      const blocks = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Channel Responses* (${responses.length} total)`
          }
        },
        {
          type: 'divider'
        }
      ];
      
      if (responses.length === 0) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'No channel auto-responses created yet. Click "Add Channel Response" to create your first one!'
          }
        });
      } else {
        responses.forEach((response, index) => {
          const statusIcon = response.enabled === false ? '🔴' : '🟢';
          const statusText = response.enabled === false ? 'Disabled' : 'Enabled';
          
          blocks.push({
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${statusIcon} *${response.channelId}* (${statusText})\n_${response.responseText.substring(0, 100)}${response.responseText.length > 100 ? '...' : ''}_`
            }
          });
          
          blocks.push({
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '✏️ Edit'
                },
                action_id: `edit_channel_response_${response.id}`,
                value: response.id
              },
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: response.enabled === false ? '✅ Enable' : '⏸️ Disable'
                },
                action_id: `toggle_channel_response_${response.id}`,
                value: response.id,
                style: response.enabled === false ? 'primary' : undefined
              },
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '🗑️ Delete'
                },
                action_id: `delete_channel_response_${response.id}`,
                value: response.id,
                style: 'danger'
              }
            ]
          });
          
          if (index < responses.length - 1) {
            blocks.push({
              type: 'divider'
            });
          }
        });
      }
      
      await client.views.update({
        view_id: body.view.id,
        view: {
          type: 'modal',
          callback_id: 'view_channel_auto_responses',
          title: {
            type: 'plain_text',
            text: 'Channel Responses'
          },
          close: {
            type: 'plain_text',
            text: 'Close'
          },
          blocks: blocks
        }
      });
      
      await client.chat.postMessage({
        channel: body.user.id,
        text: '✅ Channel auto-response deleted successfully!'
      });
    } else {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Failed to delete channel auto-response. Please try again.'
      });
    }
  } catch (error) {
    console.error('Error deleting channel auto-response:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Sorry, there was an error deleting the channel auto-response. Please try again.'
    });
  }
});

// Configure system prompt button handler
app.action('configure_system_prompt_button', async ({ ack, body, client }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    const userId = body.user.id;
    
    // Get existing system prompt if any
    const existingPrompt = await redisService.getUserSystemPrompt(teamId, userId);
    
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'configure_system_prompt',
        title: {
          type: 'plain_text',
          text: 'AI Behavior Settings'
        },
        submit: {
          type: 'plain_text',
          text: 'Save Settings'
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
              text: 'Customize how the AI assistant responds to you:'
            }
          },
          {
            type: 'input',
            block_id: 'tone',
            element: {
              type: 'static_select',
              action_id: 'tone_select',
              placeholder: {
                type: 'plain_text',
                text: 'Select tone'
              },
              initial_option: existingPrompt?.tone ? {
                text: {
                  type: 'plain_text',
                  text: existingPrompt.tone
                },
                value: existingPrompt.tone
              } : undefined,
              options: [
                {
                  text: {
                    type: 'plain_text',
                    text: 'Professional'
                  },
                  value: 'Professional'
                },
                {
                  text: {
                    type: 'plain_text',
                    text: 'Friendly'
                  },
                  value: 'Friendly'
                },
                {
                  text: {
                    type: 'plain_text',
                    text: 'Casual'
                  },
                  value: 'Casual'
                },
                {
                  text: {
                    type: 'plain_text',
                    text: 'Technical'
                  },
                  value: 'Technical'
                },
                {
                  text: {
                    type: 'plain_text',
                    text: 'Concise'
                  },
                  value: 'Concise'
                }
              ]
            },
            label: {
              type: 'plain_text',
              text: 'Response Tone'
            }
          },
          {
            type: 'input',
            block_id: 'business_type',
            element: {
              type: 'static_select',
              action_id: 'business_select',
              placeholder: {
                type: 'plain_text',
                text: 'Select business type'
              },
              initial_option: existingPrompt?.businessType ? {
                text: {
                  type: 'plain_text',
                  text: existingPrompt.businessType
                },
                value: existingPrompt.businessType
              } : undefined,
              options: [
                {
                  text: {
                    type: 'plain_text',
                    text: 'Technology'
                  },
                  value: 'Technology'
                },
                {
                  text: {
                    type: 'plain_text',
                    text: 'Manufacturing'
                  },
                  value: 'Manufacturing'
                },
                {
                  text: {
                    type: 'plain_text',
                    text: 'Healthcare'
                  },
                  value: 'Healthcare'
                },
                {
                  text: {
                    type: 'plain_text',
                    text: 'Finance'
                  },
                  value: 'Finance'
                },
                {
                  text: {
                    type: 'plain_text',
                    text: 'Education'
                  },
                  value: 'Education'
                },
                {
                  text: {
                    type: 'plain_text',
                    text: 'Retail'
                  },
                  value: 'Retail'
                },
                {
                  text: {
                    type: 'plain_text',
                    text: 'Other'
                  },
                  value: 'Other'
                }
              ]
            },
            label: {
              type: 'plain_text',
              text: 'Business Type'
            }
          },
          {
            type: 'input',
            block_id: 'company_name',
            element: {
              type: 'plain_text_input',
              action_id: 'company_text',
              placeholder: {
                type: 'plain_text',
                text: 'e.g., Acme Corp, TechStart Inc, Global Solutions'
              },
              max_length: 100,
              initial_value: existingPrompt?.companyName || ''
            },
            label: {
              type: 'plain_text',
              text: 'Company Name (Optional)'
            },
            optional: true
          },
          {
            type: 'input',
            block_id: 'additional_directions',
            element: {
              type: 'plain_text_input',
              action_id: 'directions_text',
              multiline: true,
              placeholder: {
                type: 'plain_text',
                text: 'e.g., "Always provide code examples when discussing programming", "Focus on cost-benefit analysis", "Use industry-specific terminology"'
              },
              max_length: 1000,
              initial_value: existingPrompt?.additionalDirections || ''
            },
            label: {
              type: 'plain_text',
              text: 'Additional Directions (Optional)'
            },
            optional: true
          },
          {
            type: 'input',
            block_id: 'welcome_message',
            element: {
              type: 'plain_text_input',
              action_id: 'welcome_text',
              placeholder: {
                type: 'plain_text',
                text: 'e.g., "Hi! I\'m your AI assistant. What can I help you with today?"'
              },
              max_length: 500,
              initial_value: existingPrompt?.welcomeMessage || ''
            },
            label: {
              type: 'plain_text',
              text: 'Welcome Message (Optional)'
            },
            optional: true
          }
        ]
      }
    });
  } catch (error) {
    console.error('Error opening system prompt configuration modal:', error);
  }
});

// Configure system prompt modal submission handler
app.view('configure_system_prompt', async ({ ack, body, view, client }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    const userId = body.user.id;
    const values = view.state.values;
    
    const tone = values.tone.tone_select.selected_option?.value;
    const businessType = values.business_type.business_select.selected_option?.value;
    const companyName = values.company_name.company_text.value?.trim() || '';
    const additionalDirections = values.additional_directions.directions_text.value?.trim() || '';
    const welcomeMessage = values.welcome_message.welcome_text.value?.trim() || '';
    
    if (!tone || !businessType) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Please select both tone and business type. Please try again.'
      });
      return;
    }
    
    const promptData = {
      tone: tone,
      businessType: businessType,
      companyName: companyName,
      additionalDirections: additionalDirections,
      welcomeMessage: welcomeMessage
    };
    
    const success = await redisService.saveUserSystemPrompt(teamId, userId, promptData);
    
    if (success) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: `✅ AI behavior settings saved successfully!\n\n**Tone:** ${tone}\n**Business Type:** ${businessType}${companyName ? `\n**Company:** ${companyName}` : ''}${welcomeMessage ? `\n**Welcome Message:** ${welcomeMessage}` : ''}${additionalDirections ? `\n**Additional Directions:** ${additionalDirections}` : ''}\n\nThe AI will now use these settings in all future conversations.`
      });
    } else {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Failed to save AI behavior settings. Please try again.'
      });
    }
  } catch (error) {
    console.error('Error processing system prompt configuration:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Sorry, there was an error saving your AI behavior settings. Please try again.'
    });
  }
});

// Connect Salesforce button handler
app.action('connect_salesforce_button', async ({ ack, body, client }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    const userId = body.user.id;
    
    // Check if user already has Salesforce connected
    const existingTokens = await redisService.getSalesforceTokens(teamId, userId);
    
    if (existingTokens) {
      // Show options to reconfigure or disconnect
      await client.chat.postMessage({
        channel: body.user.id,
        text: `✅ You already have Salesforce connected!\n\n**Org:** ${existingTokens.instance_url}\n**Connected:** ${new Date(existingTokens.createdAt).toLocaleDateString()}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `✅ *Salesforce Connected*\n\n**Org:** ${existingTokens.instance_url}\n**Connected:** ${new Date(existingTokens.createdAt).toLocaleDateString()}`
            }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '🔄 Reconfigure'
                },
                action_id: 'reconfigure_salesforce_button',
                style: 'primary'
              },
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '❌ Disconnect'
                },
                action_id: 'disconnect_salesforce_button',
                style: 'danger'
              }
            ]
          }
        ]
      });
      return;
    }
    
    // Open Salesforce setup modal
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'salesforce_setup',
        title: {
          type: 'plain_text',
          text: 'Setup Salesforce'
        },
        submit: {
          type: 'plain_text',
          text: 'Connect'
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
              text: 'Configure your Salesforce integration by providing your credentials:'
            }
          },
          {
            type: 'input',
            block_id: 'instance_url',
            element: {
              type: 'plain_text_input',
              action_id: 'instance_url_input',
              placeholder: {
                type: 'plain_text',
                text: 'https://yourcompany.my.salesforce.com'
              }
            },
            label: {
              type: 'plain_text',
              text: 'Instance URL'
            }
          },
          {
            type: 'input',
            block_id: 'access_token',
            element: {
              type: 'plain_text_input',
              action_id: 'access_token_input',
              placeholder: {
                type: 'plain_text',
                text: 'Your Salesforce access token'
              }
            },
            label: {
              type: 'plain_text',
              text: 'Access Token'
            }
          },
          {
            type: 'input',
            block_id: 'refresh_token',
            element: {
              type: 'plain_text_input',
              action_id: 'refresh_token_input',
              placeholder: {
                type: 'plain_text',
                text: 'Your Salesforce refresh token (optional)'
              }
            },
            label: {
              type: 'plain_text',
              text: 'Refresh Token (Optional)'
            },
            optional: true
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: '💡 *Tip:* You can get these tokens from your Salesforce org by going to Setup → My Personal Information → My Session ID, or by using Salesforce CLI.'
              }
            ]
          }
        ]
      }
    });
  } catch (error) {
    console.error('Error handling Salesforce connection:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Sorry, there was an error connecting to Salesforce. Please try again.'
    });
  }
});

// Salesforce setup modal submission handler
app.view('salesforce_setup', async ({ ack, body, view, client }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    const userId = body.user.id;
    
    const instanceUrl = view.state.values.instance_url.instance_url_input.value?.trim();
    const accessToken = view.state.values.access_token.access_token_input.value?.trim();
    const refreshToken = view.state.values.refresh_token.refresh_token_input.value?.trim();
    
    if (!instanceUrl || !accessToken) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Please provide both Instance URL and Access Token to connect Salesforce.'
      });
      return;
    }
    
    // Validate instance URL format
    if (!instanceUrl.startsWith('https://') || !instanceUrl.includes('.salesforce.com')) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Please provide a valid Salesforce instance URL (e.g., https://yourcompany.my.salesforce.com)'
      });
      return;
    }
    
    // Save Salesforce tokens to Redis
    const tokenData = {
      access_token: accessToken,
      refresh_token: refreshToken || null,
      instance_url: instanceUrl,
      id: `sf_${Date.now()}`
    };
    
    const saved = await redisService.saveSalesforceTokens(teamId, userId, tokenData);
    
    if (saved) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: `✅ **Salesforce Connected Successfully!**\n\n**Org:** ${instanceUrl}\n**Connected:** ${new Date().toLocaleDateString()}\n\nYour AI assistant can now help you with Salesforce operations!\n\n**What you can do now:**\n• Create leads, opportunities, and accounts\n• Update records and create tasks\n• Query your Salesforce data\n• Get AI-powered insights from your CRM data\n\nTo disconnect, use: \`/disconnect-salesforce\``
      });
    } else {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Failed to save Salesforce credentials. Please try again.'
      });
    }
  } catch (error) {
    console.error('Error processing Salesforce setup:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Sorry, there was an error setting up Salesforce integration. Please try again.'
    });
  }
});

// Reconfigure Salesforce button handler
app.action('reconfigure_salesforce_button', async ({ ack, body, client }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    const userId = body.user.id;
    
    // Get existing tokens to pre-fill the modal
    const existingTokens = await redisService.getSalesforceTokens(teamId, userId);
    
    // Open Salesforce setup modal with pre-filled values
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'salesforce_setup',
        title: {
          type: 'plain_text',
          text: 'Reconfigure Salesforce'
        },
        submit: {
          type: 'plain_text',
          text: 'Update'
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
              text: 'Update your Salesforce integration settings:'
            }
          },
          {
            type: 'input',
            block_id: 'instance_url',
            element: {
              type: 'plain_text_input',
              action_id: 'instance_url_input',
              placeholder: {
                type: 'plain_text',
                text: 'https://yourcompany.my.salesforce.com'
              },
              initial_value: existingTokens?.instance_url || ''
            },
            label: {
              type: 'plain_text',
              text: 'Instance URL'
            }
          },
          {
            type: 'input',
            block_id: 'access_token',
            element: {
              type: 'plain_text_input',
              action_id: 'access_token_input',
              placeholder: {
                type: 'plain_text',
                text: 'Your Salesforce access token'
              },
              initial_value: existingTokens?.access_token || ''
            },
            label: {
              type: 'plain_text',
              text: 'Access Token'
            }
          },
          {
            type: 'input',
            block_id: 'refresh_token',
            element: {
              type: 'plain_text_input',
              action_id: 'refresh_token_input',
              placeholder: {
                type: 'plain_text',
                text: 'Your Salesforce refresh token (optional)'
              },
              initial_value: existingTokens?.refresh_token || ''
            },
            label: {
              type: 'plain_text',
              text: 'Refresh Token (Optional)'
            },
            optional: true
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: '💡 *Tip:* You can get these tokens from your Salesforce org by going to Setup → My Personal Information → My Session ID, or by using Salesforce CLI.'
              }
            ]
          }
        ]
      }
    });
  } catch (error) {
    console.error('Error handling Salesforce reconfiguration:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Sorry, there was an error opening the Salesforce reconfiguration modal. Please try again.'
    });
  }
});

// Disconnect Salesforce button handler
app.action('disconnect_salesforce_button', async ({ ack, body, client }) => {
  await ack();
  
  try {
    const teamId = body.team?.id || body.user?.team_id || 'unknown';
    const userId = body.user.id;
    
    const success = await redisService.deleteSalesforceTokens(teamId, userId);
    
    if (success) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '✅ Salesforce connection has been disconnected successfully. You can reconnect anytime using the "🔗 Connect" button.'
      });
    } else {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ No Salesforce connection found to disconnect.'
      });
    }
  } catch (error) {
    console.error('Error disconnecting Salesforce:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Sorry, there was an error disconnecting Salesforce. Please try again.'
    });
  }
});

// Disconnect Salesforce command
app.command('/disconnect-salesforce', async ({ command, ack, respond }) => {
  await ack();
  
  try {
    const teamId = command.team_id;
    const userId = command.user_id;
    
    const success = await redisService.deleteSalesforceTokens(teamId, userId);
    
    if (success) {
      await respond('✅ Salesforce connection has been disconnected successfully.');
    } else {
      await respond('❌ No Salesforce connection found to disconnect.');
    }
  } catch (error) {
    console.error('Error disconnecting Salesforce:', error);
    await respond('Sorry, there was an error disconnecting Salesforce. Please try again.');
  }
});

// Clear Redis command (temporary - remove after use)
app.command('/clear-redis', async ({ command, ack, respond }) => {
  await ack();
  
  try {
    await redisService.client.flushall();
    await respond('✅ Redis data cleared successfully! You can now reinstall your Slack app.');
  } catch (error) {
    console.error('Error clearing Redis:', error);
    await respond(`❌ Error clearing Redis: ${error.message}`);
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
    
    console.log('✅ Salesforce integration configured for multi-tenant setup');

    // App Home handler
    app.event('app_home_opened', async ({ event, client, context }) => {
      try {
        console.log('App Home opened by user:', event.user);
        console.log('App Home event context:', { context: context, eventTeam: event.team });
        
        const teamId = context.teamId || event.team;
        const userId = event.user;
        
        if (!teamId) {
          console.log('No team ID found in app_home_opened event, skipping home view publish');
          return;
        }
        
        // No need to check integration status for static layout
        
        const blocks = [
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
              text: '*Salesforce Integration:*\nConnect your Salesforce org'
            },
            accessory: {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '🔗 Connect'
              },
              action_id: 'connect_salesforce_button',
              value: 'connect_salesforce'
            }
          },
          {
            type: 'divider'
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*AI Behavior Settings:*\nCustomize how I respond to you'
            },
            accessory: {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '⚙️ Configure'
              },
              action_id: 'configure_system_prompt_button',
              value: 'configure_prompt'
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
              text: '*Key-Phrase Responses:*\nSet up automatic responses that bypass the AI for specific phrases:'
            }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '➕ Add Response'
                },
                action_id: 'add_key_phrase_response_button',
                style: 'primary'
              },
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '📋 View Responses'
                },
                action_id: 'view_key_phrase_responses_button'
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
              text: '*Channel Auto-Responses:*\nSet up automatic responses in specific channels (responds in threads):'
            }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '➕ Add Channel Response'
                },
                action_id: 'add_channel_auto_response_button',
                style: 'primary'
              },
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '📋 View Channel Responses'
                },
                action_id: 'view_channel_auto_responses_button'
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
                  text: '🧹 Clean Chat History'
                },
                action_id: 'clean_chat_history_button',
                style: 'danger'
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
        ];


        await client.views.publish({
          user_id: event.user,
          view: {
            type: 'home',
            blocks: blocks
          }
        });
      } catch (error) {
        console.error('Error publishing home view:', error);
      }
    });

    // Help button handler
    app.action('help_button', async ({ ack, say }) => {
      await ack();
      await say('I\'m an AI assistant powered by GROK! I can help you with questions, provide information, and assist with various tasks. Just ask me anything!');
    });

    // Clear chat history button handler
    app.action('clear_chat_history_button', async ({ ack, body, client }) => {
      await ack();
      
      try {
        const userId = body.user.id;
        const teamId = body.team.id;
        
        // Clear conversation history from Redis
        await redisService.clearConversation(teamId, userId);
        
        // Send confirmation message
        await client.chat.postMessage({
          channel: userId,
          text: '🗑️ *Chat history cleared!*\n\nYour conversation history has been successfully cleared. Future conversations will start fresh without previous context.'
        });
      } catch (error) {
        console.error('Error clearing chat history:', error);
        await client.chat.postMessage({
          channel: body.user.id,
          text: '❌ Sorry, there was an error clearing your chat history. Please try again later.'
        });
      }
    });

    // Clean chat history button handler (alternative action_id)
    app.action('clean_chat_history_button', async ({ ack, body, client }) => {
      await ack();
      
      try {
        const userId = body.user.id;
        const teamId = body.team.id;
        
        // Clear conversation history from Redis
        await redisService.clearConversation(teamId, userId);
        
        // Send confirmation message
        await client.chat.postMessage({
          channel: userId,
          text: '🧹 *Chat history cleaned!*\n\nYour conversation history has been successfully cleaned. Future conversations will start fresh without previous context.'
        });
      } catch (error) {
        console.error('Error cleaning chat history:', error);
        await client.chat.postMessage({
          channel: body.user.id,
          text: '❌ Sorry, there was an error cleaning your chat history. Please try again later.'
        });
      }
    });

    // Add temporary Redis clear endpoint (remove after use)
    if (app.receiver && app.receiver.router) {
      app.receiver.router.get('/clear-redis', async (req, res) => {
        try {
          await redisService.client.flushall();
          res.send('✅ Redis data cleared successfully!');
        } catch (error) {
          res.status(500).send(`❌ Error clearing Redis: ${error.message}`);
        }
      });
      console.log('✅ Redis clear endpoint added at /clear-redis');
    }

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
