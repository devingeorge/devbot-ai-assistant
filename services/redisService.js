const Redis = require('ioredis');

class RedisService {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.isMock = false;
  }

  async connect() {
    try {
      // Skip Redis connection if no URL is provided
      if (!process.env.REDIS_URL) {
        console.log('⚠️ No REDIS_URL provided - using mock Redis');
        this.createMockRedis();
        return true;
      }

      console.log('Attempting to connect to Redis:', process.env.REDIS_URL);

      this.client = new Redis(process.env.REDIS_URL, {
        connectTimeout: 5000,
        lazyConnect: true,
        retryDelayOnFailover: 100,
        maxRetriesPerRequest: 2,
        enableReadyCheck: false,
        maxRetriesPerRequest: null,
      });

      this.client.on('error', (err) => {
        console.warn('Redis connection error:', err.message);
        this.isConnected = false;
      });

      this.client.on('connect', () => {
        console.log('✅ Redis Client Connected');
        this.isConnected = true;
      });

      this.client.on('ready', () => {
        console.log('✅ Redis Client Ready');
        this.isConnected = true;
      });

      this.client.on('reconnecting', () => {
        console.log('🔄 Redis Client Reconnecting...');
        this.isConnected = false;
      });

      // Try to connect
      await this.client.connect();
      console.log('✅ Redis connection successful');
      return true;
    } catch (error) {
      console.warn('Redis initialization failed:', error.message);
      console.log('⚠️ Using mock Redis - integration features will be limited');
      this.createMockRedis();
      return true;
    }
  }

  createMockRedis() {
    this.isMock = true;
    this.isConnected = false;
    this.client = {
      setex: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      del: () => Promise.resolve(),
      keys: () => Promise.resolve([]),
      rpush: () => Promise.resolve(),
      ltrim: () => Promise.resolve(),
      expire: () => Promise.resolve(),
      lrange: () => Promise.resolve([]),
      quit: () => Promise.resolve(),
      ping: () => Promise.resolve('PONG'),
    };
    console.log('✅ Mock Redis client created');
  }

  async disconnect() {
    if (this.client && !this.isMock) {
      await this.client.disconnect();
      this.isConnected = false;
    }
  }

  // Slack Installation Store Implementation
  async saveInstallation(installation, isEnterpriseInstall) {
    if (this.isMock) {
      console.log(`Mock Redis - saved installation for ${isEnterpriseInstall ? 'enterprise' : 'team'}`);
      return Promise.resolve();
    }
    
    try {
      const key = isEnterpriseInstall 
        ? `installation:${installation.enterprise.id}`
        : `installation:${installation.team.id}`;
      
      await this.client.setex(key, 86400 * 30, JSON.stringify(installation)); // 30 days TTL
      console.log(`Saved installation for ${isEnterpriseInstall ? 'enterprise' : 'team'}: ${key}`);
      return Promise.resolve();
    } catch (error) {
      console.error('Error saving installation:', error);
      return Promise.reject(error);
    }
  }

  async getInstallation(query, isEnterpriseInstall) {
    if (this.isMock) {
      console.log(`Mock Redis - getting installation for ${isEnterpriseInstall ? 'enterprise' : 'team'}`);
      return Promise.resolve(undefined);
    }
    
    try {
      const key = isEnterpriseInstall 
        ? `installation:${query.enterpriseId}`
        : `installation:${query.teamId}`;
      
      const data = await this.client.get(key);
      return Promise.resolve(data ? JSON.parse(data) : undefined);
    } catch (error) {
      console.error('Error getting installation:', error);
      return Promise.reject(error);
    }
  }

  async deleteInstallation(query, isEnterpriseInstall) {
    if (this.isMock) {
      console.log(`Mock Redis - deleted installation for ${isEnterpriseInstall ? 'enterprise' : 'team'}`);
      return Promise.resolve();
    }
    
    try {
      const key = isEnterpriseInstall 
        ? `installation:${query.enterpriseId}`
        : `installation:${query.teamId}`;
      
      await this.client.del(key);
      console.log(`Deleted installation for ${isEnterpriseInstall ? 'enterprise' : 'team'}: ${key}`);
      return Promise.resolve();
    } catch (error) {
      console.error('Error deleting installation:', error);
      return Promise.reject(error);
    }
  }

  // Credential Management for Integrations
  async saveCredentials(teamId, integrationType, credentials) {
    if (this.isMock) {
      console.log(`Mock Redis - saved ${integrationType} credentials for team: ${teamId}`);
      return true;
    }
    
    try {
      const key = `credentials:${teamId}:${integrationType}`;
      await this.client.setex(key, 86400 * 90, JSON.stringify(credentials)); // 90 days TTL
      console.log(`Saved ${integrationType} credentials for team: ${teamId}`);
      return true;
    } catch (error) {
      console.error('Error saving credentials:', error);
      return false;
    }
  }

  async getCredentials(teamId, integrationType) {
    if (this.isMock) {
      console.log(`Mock Redis - getting ${integrationType} credentials for team: ${teamId}`);
      return null;
    }
    
    try {
      const key = `credentials:${teamId}:${integrationType}`;
      const data = await this.client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Error getting credentials:', error);
      return null;
    }
  }

  async deleteCredentials(teamId, integrationType) {
    if (this.isMock) {
      console.log(`Mock Redis - deleted ${integrationType} credentials for team: ${teamId}`);
      return true;
    }
    
    try {
      const key = `credentials:${teamId}:${integrationType}`;
      await this.client.del(key);
      console.log(`Deleted ${integrationType} credentials for team: ${teamId}`);
      return true;
    } catch (error) {
      console.error('Error deleting credentials:', error);
      return false;
    }
  }

  async listIntegrations(teamId) {
    if (this.isMock) {
      console.log(`Mock Redis - listing integrations for team: ${teamId}`);
      return [];
    }
    
    try {
      const pattern = `credentials:${teamId}:*`;
      const keys = await this.client.keys(pattern);
      return keys.map(key => key.split(':')[2]); // Extract integration type
    } catch (error) {
      console.error('Error listing integrations:', error);
      return [];
    }
  }

  // User Preferences
  async saveUserPreferences(teamId, userId, preferences) {
    if (this.isMock) {
      console.log(`Mock Redis - saved preferences for user: ${userId}`);
      return true;
    }
    
    try {
      const key = `preferences:${teamId}:${userId}`;
      await this.client.setex(key, 86400 * 365, JSON.stringify(preferences)); // 1 year TTL
      return true;
    } catch (error) {
      console.error('Error saving user preferences:', error);
      return false;
    }
  }

  async getUserPreferences(teamId, userId) {
    if (this.isMock) {
      console.log(`Mock Redis - getting preferences for user: ${userId}`);
      return null;
    }
    
    try {
      const key = `preferences:${teamId}:${userId}`;
      const data = await this.client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Error getting user preferences:', error);
      return null;
    }
  }

  // Suggested Prompts Management
  async saveSuggestedPrompt(teamId, promptData) {
    if (!this.isConnected) {
      console.warn('Redis not connected, cannot save suggested prompt.');
      return false;
    }
    try {
      const promptId = promptData.id || `prompt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const key = `suggested_prompts:${teamId}:${promptId}`;
      
      const promptWithId = {
        ...promptData,
        id: promptId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      await this.client.set(key, JSON.stringify(promptWithId), 'EX', 86400 * 365); // 1 year TTL
      console.log(`Saved suggested prompt ${promptId} for team: ${teamId}`);
      return promptId;
    } catch (error) {
      console.error('Error saving suggested prompt:', error);
      return false;
    }
  }

  async getSuggestedPrompt(teamId, promptId) {
    if (!this.isConnected) {
      console.warn('Redis not connected, cannot get suggested prompt.');
      return null;
    }
    try {
      const key = `suggested_prompts:${teamId}:${promptId}`;
      const data = await this.client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Error getting suggested prompt:', error);
      return null;
    }
  }

  async getAllSuggestedPrompts(teamId) {
    if (!this.isConnected) {
      console.warn('Redis not connected, cannot get suggested prompts.');
      return [];
    }
    try {
      const pattern = `suggested_prompts:${teamId}:*`;
      const keys = await this.client.keys(pattern);
      
      if (keys.length === 0) {
        return [];
      }
      
      const prompts = [];
      for (const key of keys) {
        const data = await this.client.get(key);
        if (data) {
          prompts.push(JSON.parse(data));
        }
      }
      
      // Sort by creation date (newest first)
      return prompts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    } catch (error) {
      console.error('Error getting all suggested prompts:', error);
      return [];
    }
  }

  async updateSuggestedPrompt(teamId, promptId, updates) {
    if (!this.isConnected) {
      console.warn('Redis not connected, cannot update suggested prompt.');
      return false;
    }
    try {
      const key = `suggested_prompts:${teamId}:${promptId}`;
      const existingData = await this.client.get(key);
      
      if (!existingData) {
        return false;
      }
      
      const existingPrompt = JSON.parse(existingData);
      const updatedPrompt = {
        ...existingPrompt,
        ...updates,
        id: promptId, // Ensure ID doesn't change
        updatedAt: new Date().toISOString()
      };
      
      await this.client.set(key, JSON.stringify(updatedPrompt), 'EX', 86400 * 365); // 1 year TTL
      console.log(`Updated suggested prompt ${promptId} for team: ${teamId}`);
      return true;
    } catch (error) {
      console.error('Error updating suggested prompt:', error);
      return false;
    }
  }

  async deleteSuggestedPrompt(teamId, promptId) {
    if (!this.isConnected) {
      console.warn('Redis not connected, cannot delete suggested prompt.');
      return false;
    }
    try {
      const key = `suggested_prompts:${teamId}:${promptId}`;
      await this.client.del(key);
      console.log(`Deleted suggested prompt ${promptId} for team: ${teamId}`);
      return true;
    } catch (error) {
      console.error('Error deleting suggested prompt:', error);
      return false;
    }
  }

  // Key-Phrase Responses Management
  async saveKeyPhraseResponse(teamId, responseData) {
    if (!this.isConnected) {
      console.warn('Redis not connected, cannot save key-phrase response.');
      return false;
    }
    try {
      const responseId = responseData.id || `response_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const key = `key_phrase_responses:${teamId}:${responseId}`;
      
      const responseWithId = {
        ...responseData,
        id: responseId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      await this.client.set(key, JSON.stringify(responseWithId), 'EX', 86400 * 365); // 1 year TTL
      console.log(`Saved key-phrase response ${responseId} for team: ${teamId}`);
      return responseId;
    } catch (error) {
      console.error('Error saving key-phrase response:', error);
      return false;
    }
  }

  // Channel Auto-Responses Management
  async saveChannelAutoResponse(teamId, responseData) {
    if (!this.isConnected) {
      console.warn('Redis not connected, cannot save channel auto-response.');
      return false;
    }
    try {
      const responseId = responseData.id || `channel_response_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const key = `channel_auto_responses:${teamId}:${responseId}`;
      
      const responseWithId = {
        ...responseData,
        id: responseId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      await this.client.set(key, JSON.stringify(responseWithId), 'EX', 86400 * 365); // 1 year TTL
      console.log(`Saved channel auto-response ${responseId} for team: ${teamId}`);
      return responseId;
    } catch (error) {
      console.error('Error saving channel auto-response:', error);
      return false;
    }
  }

  async getKeyPhraseResponse(teamId, responseId) {
    if (!this.isConnected) {
      console.warn('Redis not connected, cannot get key-phrase response.');
      return null;
    }
    try {
      const key = `key_phrase_responses:${teamId}:${responseId}`;
      const data = await this.client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Error getting key-phrase response:', error);
      return null;
    }
  }

  async getAllKeyPhraseResponses(teamId) {
    if (!this.isConnected) {
      console.warn('Redis not connected, cannot get key-phrase responses.');
      return [];
    }
    try {
      const pattern = `key_phrase_responses:${teamId}:*`;
      const keys = await this.client.keys(pattern);
      
      if (keys.length === 0) {
        return [];
      }
      
      const responses = [];
      for (const key of keys) {
        const data = await this.client.get(key);
        if (data) {
          responses.push(JSON.parse(data));
        }
      }
      
      // Sort by creation date (newest first)
      return responses.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    } catch (error) {
      console.error('Error getting all key-phrase responses:', error);
      return [];
    }
  }

  async updateKeyPhraseResponse(teamId, responseId, updates) {
    if (!this.isConnected) {
      console.warn('Redis not connected, cannot update key-phrase response.');
      return false;
    }
    try {
      const key = `key_phrase_responses:${teamId}:${responseId}`;
      const existingData = await this.client.get(key);
      
      if (!existingData) {
        return false;
      }
      
      const existingResponse = JSON.parse(existingData);
      const updatedResponse = {
        ...existingResponse,
        ...updates,
        id: responseId, // Ensure ID doesn't change
        updatedAt: new Date().toISOString()
      };
      
      await this.client.set(key, JSON.stringify(updatedResponse), 'EX', 86400 * 365); // 1 year TTL
      console.log(`Updated key-phrase response ${responseId} for team: ${teamId}`);
      return true;
    } catch (error) {
      console.error('Error updating key-phrase response:', error);
      return false;
    }
  }

  async deleteKeyPhraseResponse(teamId, responseId) {
    if (!this.isConnected) {
      console.warn('Redis not connected, cannot delete key-phrase response.');
      return false;
    }
    try {
      const key = `key_phrase_responses:${teamId}:${responseId}`;
      await this.client.del(key);
      console.log(`Deleted key-phrase response ${responseId} for team: ${teamId}`);
      return true;
    } catch (error) {
      console.error('Error deleting key-phrase response:', error);
      return false;
    }
  }

  async getChannelAutoResponse(teamId, responseId) {
    if (!this.isConnected) {
      console.warn('Redis not connected, cannot get channel auto-response.');
      return null;
    }
    try {
      const key = `channel_auto_responses:${teamId}:${responseId}`;
      const data = await this.client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Error getting channel auto-response:', error);
      return null;
    }
  }

  async getAllChannelAutoResponses(teamId) {
    if (!this.isConnected) {
      console.warn('Redis not connected, cannot get channel auto-responses.');
      return [];
    }
    try {
      const pattern = `channel_auto_responses:${teamId}:*`;
      const keys = await this.client.keys(pattern);
      
      if (keys.length === 0) {
        return [];
      }
      
      const responses = [];
      for (const key of keys) {
        const data = await this.client.get(key);
        if (data) {
          responses.push(JSON.parse(data));
        }
      }
      
      // Sort by creation date (newest first)
      return responses.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    } catch (error) {
      console.error('Error getting all channel auto-responses:', error);
      return [];
    }
  }

  async updateChannelAutoResponse(teamId, responseId, updates) {
    if (!this.isConnected) {
      console.warn('Redis not connected, cannot update channel auto-response.');
      return false;
    }
    try {
      const key = `channel_auto_responses:${teamId}:${responseId}`;
      const existingData = await this.client.get(key);
      
      if (!existingData) {
        return false;
      }
      
      const existingResponse = JSON.parse(existingData);
      const updatedResponse = {
        ...existingResponse,
        ...updates,
        id: responseId, // Ensure ID doesn't change
        updatedAt: new Date().toISOString()
      };
      
      await this.client.set(key, JSON.stringify(updatedResponse), 'EX', 86400 * 365); // 1 year TTL
      console.log(`Updated channel auto-response ${responseId} for team: ${teamId}`);
      return true;
    } catch (error) {
      console.error('Error updating channel auto-response:', error);
      return false;
    }
  }

  async deleteChannelAutoResponse(teamId, responseId) {
    if (!this.isConnected) {
      console.warn('Redis not connected, cannot delete channel auto-response.');
      return false;
    }
    try {
      const key = `channel_auto_responses:${teamId}:${responseId}`;
      await this.client.del(key);
      console.log(`Deleted channel auto-response ${responseId} for team: ${teamId}`);
      return true;
    } catch (error) {
      console.error('Error deleting channel auto-response:', error);
      return false;
    }
  }

  // Health check
  async healthCheck() {
    if (this.isMock) return true;
    
    try {
      await this.client.ping();
      return true;
    } catch (error) {
      console.error('Redis health check failed:', error);
      return false;
    }
  }

  // Graceful shutdown
  async quit() {
    if (this.client && !this.isMock) {
      try {
        await this.client.quit();
        console.log('✅ Redis connection closed gracefully');
      } catch (error) {
        console.error('Error closing Redis connection:', error);
      }
    }
  }
}

module.exports = new RedisService();