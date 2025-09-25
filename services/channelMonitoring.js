const redisService = require('./redisService');

// Simple logger for now
const logger = {
  info: (message, data) => console.log(`[INFO] ${message}`, data || ''),
  error: (message, data) => console.error(`[ERROR] ${message}`, data || ''),
};

/** Generate storage key for monitored channels */
function monitoredChannelsKey(teamId) {
  return `monitored_channels:${teamId}`;
}

/** Get all monitored channels for a team */
async function getMonitoredChannels(teamId) {
  try {
    const key = monitoredChannelsKey(teamId);
    const channels = await redisService.get(key);
    return channels ? JSON.parse(channels) : [];
  } catch (error) {
    logger.error('Error getting monitored channels:', error);
    return [];
  }
}

/** Add a channel to monitoring */
async function addMonitoredChannel(teamId, channelData) {
  try {
    const channels = await getMonitoredChannels(teamId);

    // Check if already monitoring 5 channels (max limit)
    if (channels.length >= 5) {
      return {
        success: false,
        error: 'Maximum of 5 channels can be monitored',
      };
    }

    // Check if channel is already being monitored
    const existingChannel = channels.find(
      (c) => c.channelId === channelData.channelId,
    );
    if (existingChannel) {
      return { success: false, error: 'Channel is already being monitored' };
    }

    const newChannel = {
      channelId: channelData.channelId,
      channelName: channelData.channelName,
      responseType: channelData.responseType || 'analytical',
      enabled: channelData.enabled !== false,
      autoCreateJiraTickets: channelData.autoCreateJiraTickets || false,
      addedAt: new Date().toISOString(),
      addedBy: channelData.addedBy,
    };

    channels.push(newChannel);

    const key = monitoredChannelsKey(teamId);
    await redisService.set(key, JSON.stringify(channels), 365 * 24 * 3600); // 1 year TTL

    logger.info('Added monitored channel:', { teamId, channelData });
    return { success: true, channel: newChannel };
  } catch (error) {
    logger.error('Error adding monitored channel:', error);
    return { success: false, error: error.message };
  }
}

/** Update a monitored channel */
async function updateMonitoredChannel(teamId, channelId, updates) {
  try {
    const channels = await getMonitoredChannels(teamId);
    const channelIndex = channels.findIndex((c) => c.channelId === channelId);

    if (channelIndex === -1) {
      return { success: false, error: 'Channel not found' };
    }

    channels[channelIndex] = {
      ...channels[channelIndex],
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    const key = monitoredChannelsKey(teamId);
    await redisService.set(key, JSON.stringify(channels), 365 * 24 * 3600);

    logger.info('Updated monitored channel:', { teamId, channelId, updates });
    return { success: true, channel: channels[channelIndex] };
  } catch (error) {
    logger.error('Error updating monitored channel:', error);
    return { success: false, error: error.message };
  }
}

/** Remove a channel from monitoring */
async function removeMonitoredChannel(teamId, channelId) {
  try {
    const channels = await getMonitoredChannels(teamId);
    const filteredChannels = channels.filter((c) => c.channelId !== channelId);

    if (channels.length === filteredChannels.length) {
      return { success: false, error: 'Channel not found' };
    }

    const key = monitoredChannelsKey(teamId);
    await redisService.set(
      key,
      JSON.stringify(filteredChannels),
      365 * 24 * 3600,
    );

    logger.info('Removed monitored channel:', { teamId, channelId });
    return { success: true };
  } catch (error) {
    logger.error('Error removing monitored channel:', error);
    return { success: false, error: error.message };
  }
}

/** Check if a channel is being monitored */
async function isChannelMonitored(teamId, channelId) {
  try {
    const channels = await getMonitoredChannels(teamId);
    const channel = channels.find(
      (c) => c.channelId === channelId && c.enabled,
    );
    return channel || null;
  } catch (error) {
    logger.error('Error checking if channel is monitored:', error);
    return null;
  }
}

/** Get response types available for channel monitoring */
function getResponseTypes() {
  return [
    {
      value: 'analytical',
      label: 'Analytical',
      description: 'Analyze messages for insights, patterns, and key points',
    },
    {
      value: 'summary',
      label: 'Summary',
      description: 'Provide concise summaries of recent activity',
    },
    {
      value: 'questions',
      label: 'Questions',
      description: 'Ask clarifying questions to facilitate discussion',
    },
    {
      value: 'insights',
      label: 'Insights',
      description: 'Share observations and actionable insights',
    },
  ];
}

/** Generate storage key for thread response counts */
function threadResponseCountKey(teamId, channelId, threadTs) {
  return `thread_response_count:${teamId}:${channelId}:${threadTs}`;
}

/** Increment and get bot response count for a thread */
async function incrementThreadResponseCount(teamId, channelId, threadTs) {
  try {
    const key = threadResponseCountKey(teamId, channelId, threadTs);
    const currentCount = await redisService.incr(key);

    // Set expiration to 30 days to prevent unlimited growth
    if (currentCount === 1) {
      await redisService.expire(key, 30 * 24 * 3600);
    }

    logger.info('Incremented thread response count:', {
      teamId,
      channelId,
      threadTs,
      count: currentCount,
    });
    return currentCount;
  } catch (error) {
    logger.error('Error incrementing thread response count:', error);
    return 0;
  }
}

/** Get current bot response count for a thread */
async function getThreadResponseCount(teamId, channelId, threadTs) {
  try {
    const key = threadResponseCountKey(teamId, channelId, threadTs);
    const count = await redisService.get(key);
    return count ? parseInt(count, 10) : 0;
  } catch (error) {
    logger.error('Error getting thread response count:', error);
    return 0;
  }
}

// ============================================================================
// UI COMPONENTS - MODALS AND BLOCKS
// ============================================================================

/**
 * Add Monitored Channel Modal
 */
function addMonitoredChannelModal() {
  const responseTypes = getResponseTypes();

  return {
    type: 'modal',
    callback_id: 'add_monitored_channel',
    title: {
      type: 'plain_text',
      text: 'Add Channel Monitor',
    },
    submit: {
      type: 'plain_text',
      text: 'Add Monitor',
    },
    close: {
      type: 'plain_text',
      text: 'Cancel',
    },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Select a channel to monitor and configure how the AI should respond.',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Channel*',
        },
        accessory: {
          type: 'channels_select',
          placeholder: {
            type: 'plain_text',
            text: 'Select a channel',
          },
          action_id: 'channel_input',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Response Type*',
        },
        accessory: {
          type: 'static_select',
          placeholder: {
            type: 'plain_text',
            text: 'Select response type',
          },
          action_id: 'response_type_input',
          options: responseTypes.map((type) => ({
            text: {
              type: 'plain_text',
              text: type.label,
            },
            value: type.value,
            description: {
              type: 'plain_text',
              text: type.description,
            },
          })),
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Auto-Create Jira Tickets*',
        },
        accessory: {
          type: 'checkboxes',
          action_id: 'auto_jira_input',
          options: [
            {
              text: {
                type: 'plain_text',
                text: 'Create Jira ticket after 1st bot response',
              },
              value: 'enabled',
            },
          ],
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '💡 *Tip:* The AI will respond in threads to keep the main channel clean. Maximum 5 channels can be monitored.',
          },
        ],
      },
    ],
  };
}

/**
 * Manage Monitored Channels Modal
 */
function manageMonitoredChannelsModal(channels) {
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Monitored Channels*\n\nManage your channel monitoring settings.',
      },
    },
  ];

  if (channels.length === 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'No channels are currently being monitored. Click "Add Channel Monitor" to get started.',
      },
    });
  } else {
    channels.forEach((channel, _index) => {
      const statusEmoji = channel.enabled ? '✅' : '❌';
      const jiraEmoji = channel.autoCreateJiraTickets ? '🎫' : '';

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `${statusEmoji} *#${channel.channelName}*\n` +
            `Response Type: *${channel.responseType}*\n` +
            `Auto-Jira: ${channel.autoCreateJiraTickets ? 'Enabled' : 'Disabled'} ${jiraEmoji}\n` +
            `Added: ${new Date(channel.addedAt).toLocaleDateString()}`,
        },
        accessory: {
          type: 'overflow',
          action_id: `monitored_channel_actions_${channel.channelId}`,
          options: [
            {
              text: {
                type: 'plain_text',
                text: 'Edit Settings',
              },
              value: `edit_${channel.channelId}`,
            },
            {
              text: {
                type: 'plain_text',
                text: channel.enabled ? 'Disable' : 'Enable',
              },
              value: `toggle_${channel.channelId}`,
            },
            {
              text: {
                type: 'plain_text',
                text: 'Remove',
              },
              value: `remove_${channel.channelId}`,
            },
          ],
        },
      });
    });
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Add Channel Monitor',
        },
        action_id: 'add_monitored_channel',
        style: 'primary',
      },
    ],
  });

  return {
    type: 'modal',
    callback_id: 'manage_monitored_channels',
    title: {
      type: 'plain_text',
      text: 'Channel Monitoring',
    },
    close: {
      type: 'plain_text',
      text: 'Close',
    },
    blocks: blocks,
  };
}

/**
 * Edit Monitored Channel Modal
 */
function editMonitoredChannelModal(channel) {
  const responseTypes = getResponseTypes();

  return {
    type: 'modal',
    callback_id: 'edit_monitored_channel',
    title: {
      type: 'plain_text',
      text: 'Edit Channel Monitor',
    },
    submit: {
      type: 'plain_text',
      text: 'Save Changes',
    },
    close: {
      type: 'plain_text',
      text: 'Cancel',
    },
    private_metadata: JSON.stringify({ channelId: channel.channelId }),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Editing: #${channel.channelName}*`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Response Type*',
        },
        accessory: {
          type: 'static_select',
          placeholder: {
            type: 'plain_text',
            text: 'Select response type',
          },
          action_id: 'response_type_input',
          initial_option: {
            text: {
              type: 'plain_text',
              text: responseTypes.find((type) => type.value === channel.responseType)?.label || 'Analytical',
            },
            value: channel.responseType,
          },
          options: responseTypes.map((type) => ({
            text: {
              type: 'plain_text',
              text: type.label,
            },
            value: type.value,
            description: {
              type: 'plain_text',
              text: type.description,
            },
          })),
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Auto-Create Jira Tickets*',
        },
        accessory: {
          type: 'checkboxes',
          action_id: 'auto_jira_input',
          initial_options: channel.autoCreateJiraTickets
            ? [
                {
                  text: {
                    type: 'plain_text',
                    text: 'Create Jira ticket after 1st bot response',
                  },
                  value: 'enabled',
                },
              ]
            : [],
          options: [
            {
              text: {
                type: 'plain_text',
                text: 'Create Jira ticket after 1st bot response',
              },
              value: 'enabled',
            },
          ],
        },
      },
    ],
  };
}

/**
 * Get Channel Monitoring buttons for App Home
 */
function getChannelMonitoringButtons() {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Channel Monitoring*\n\nMonitor channels and get AI responses based on message content.',
      },
      accessory: {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Add Channel Monitor',
        },
        action_id: 'add_monitored_channel',
        style: 'primary',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Manage Monitored Channels',
          },
          action_id: 'manage_monitored_channels',
        },
      ],
    },
  ];
}

// Export all functions
module.exports = {
  // Core Service Functions
  getMonitoredChannels,
  addMonitoredChannel,
  updateMonitoredChannel,
  removeMonitoredChannel,
  isChannelMonitored,
  getResponseTypes,
  incrementThreadResponseCount,
  getThreadResponseCount,

  // UI Components
  addMonitoredChannelModal,
  manageMonitoredChannelsModal,
  editMonitoredChannelModal,
  getChannelMonitoringButtons,
};
