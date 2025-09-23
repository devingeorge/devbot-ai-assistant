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

  // Installation Management
  async saveInstallation(teamId, installationData) {
    if (this.isMock) {
      console.log(`Mock Redis - saved installation for team: ${teamId}`);
      return true;
    }
    
    try {
      const key = `installation:${teamId}`;
      await this.client.setex(key, 86400 * 30, JSON.stringify(installationData)); // 30 days TTL
      console.log(`Saved installation for team: ${teamId}`);
      return true;
    } catch (error) {
      console.error('Error saving installation:', error);
      return false;
    }
  }

  async getInstallation(teamId) {
    if (this.isMock) {
      console.log(`Mock Redis - getting installation for team: ${teamId}`);
      return null;
    }
    
    try {
      const key = `installation:${teamId}`;
      const data = await this.client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Error getting installation:', error);
      return null;
    }
  }

  async deleteInstallation(teamId) {
    if (this.isMock) {
      console.log(`Mock Redis - deleted installation for team: ${teamId}`);
      return true;
    }
    
    try {
      const key = `installation:${teamId}`;
      await this.client.del(key);
      console.log(`Deleted installation for team: ${teamId}`);
      return true;
    } catch (error) {
      console.error('Error deleting installation:', error);
      return false;
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