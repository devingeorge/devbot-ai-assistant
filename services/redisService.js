const { createClient } = require('redis');

class RedisService {
  constructor() {
    this.client = null;
    this.isConnected = false;
  }

  async connect() {
    try {
      // Redis is required for this app
      if (!process.env.REDIS_URL) {
        console.error('❌ Missing REDIS_URL environment variable');
        console.error('   Please set REDIS_URL in your environment variables');
        process.exit(1);
      }

      console.log('Attempting to connect to Redis:', process.env.REDIS_URL);

      this.client = createClient({
        url: process.env.REDIS_URL,
        socket: {
          connectTimeout: 30000,
          lazyConnect: false,
          reconnectStrategy: (retries) => {
            console.log(`Redis reconnection attempt ${retries}`);
            if (retries > 5) {
              console.error('Redis reconnection failed after 5 attempts');
              return false;
            }
            return Math.min(retries * 200, 5000);
          }
        }
      });

      this.client.on('error', (err) => {
        console.error('Redis Client Error:', err.message);
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

      // Connect with retry logic
      let attempts = 0;
      const maxAttempts = 5;
      
      while (attempts < maxAttempts) {
        try {
          await this.client.connect();
          console.log('✅ Redis connection successful');
          return true;
        } catch (error) {
          attempts++;
          console.error(`Redis connection attempt ${attempts} failed:`, error.message);
          
          if (attempts >= maxAttempts) {
            console.error('❌ Failed to connect to Redis after 5 attempts');
            console.error('   Please check your REDIS_URL and Redis service status');
            process.exit(1);
          }
          
          console.log(`Retrying in ${attempts * 2} seconds...`);
          await new Promise(resolve => setTimeout(resolve, attempts * 2000));
        }
      }
    } catch (error) {
      console.error('Failed to connect to Redis:', error.message);
      console.error('   Please check your REDIS_URL and Redis service status');
      process.exit(1);
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.disconnect();
      this.isConnected = false;
    }
  }

  // Installation Management
  async saveInstallation(teamId, installationData) {
    if (!this.isConnected) return false;
    
    try {
      const key = `installation:${teamId}`;
      await this.client.setEx(key, 86400 * 30, JSON.stringify(installationData)); // 30 days TTL
      console.log(`Saved installation for team: ${teamId}`);
      return true;
    } catch (error) {
      console.error('Error saving installation:', error);
      return false;
    }
  }

  async getInstallation(teamId) {
    if (!this.isConnected) return null;
    
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
    if (!this.isConnected) return false;
    
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
    if (!this.isConnected) return false;
    
    try {
      const key = `credentials:${teamId}:${integrationType}`;
      await this.client.setEx(key, 86400 * 90, JSON.stringify(credentials)); // 90 days TTL
      console.log(`Saved ${integrationType} credentials for team: ${teamId}`);
      return true;
    } catch (error) {
      console.error('Error saving credentials:', error);
      return false;
    }
  }

  async getCredentials(teamId, integrationType) {
    if (!this.isConnected) return null;
    
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
    if (!this.isConnected) return false;
    
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
    if (!this.isConnected) return [];
    
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
    if (!this.isConnected) return false;
    
    try {
      const key = `preferences:${teamId}:${userId}`;
      await this.client.setEx(key, 86400 * 365, JSON.stringify(preferences)); // 1 year TTL
      return true;
    } catch (error) {
      console.error('Error saving user preferences:', error);
      return false;
    }
  }

  async getUserPreferences(teamId, userId) {
    if (!this.isConnected) return null;
    
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
    if (!this.isConnected) return false;
    
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
    if (this.client) {
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