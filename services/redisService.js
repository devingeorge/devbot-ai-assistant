const { createClient } = require('redis');

class RedisService {
  constructor() {
    this.client = null;
    this.isConnected = false;
  }

  async connect() {
    try {
      // Skip Redis connection if no URL is provided (for local development)
      if (!process.env.REDIS_URL) {
        console.log('⚠️ No REDIS_URL provided - Redis features disabled');
        this.isConnected = false;
        return false;
      }

      this.client = createClient({
        url: process.env.REDIS_URL
      });

      this.client.on('error', (err) => {
        console.error('Redis Client Error:', err.message);
        this.isConnected = false;
      });

      this.client.on('connect', () => {
        console.log('✅ Redis Client Connected');
        this.isConnected = true;
      });

      await this.client.connect();
      return true;
    } catch (error) {
      console.error('Failed to connect to Redis:', error.message);
      this.isConnected = false;
      return false;
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
}

module.exports = new RedisService();
