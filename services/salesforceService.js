const axios = require('axios');

class SalesforceService {
  constructor() {
    this.baseUrl = null;
  }

  // Set the Salesforce instance URL
  setInstanceUrl(instanceUrl) {
    this.baseUrl = instanceUrl;
  }

  // Refresh access token if needed
  async refreshToken(refreshToken, clientId, clientSecret) {
    try {
      const response = await axios.post('https://login.salesforce.com/services/oauth2/token', {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret
      });

      return {
        access_token: response.data.access_token,
        instance_url: response.data.instance_url,
        refresh_token: response.data.refresh_token || refreshToken
      };
    } catch (error) {
      console.error('Error refreshing Salesforce token:', error.response?.data || error.message);
      throw new Error('Failed to refresh Salesforce token');
    }
  }

  // Make authenticated API call to Salesforce
  async makeApiCall(endpoint, method = 'GET', data = null, accessToken) {
    try {
      const url = `${this.baseUrl}/services/data/v58.0${endpoint}`;
      const config = {
        method,
        url,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      };

      if (data) {
        config.data = data;
      }

      const response = await axios(config);
      return response.data;
    } catch (error) {
      console.error('Salesforce API Error:', error.response?.data || error.message);
      throw error;
    }
  }

  // Create a Lead
  async createLead(leadData, accessToken) {
    try {
      const result = await this.makeApiCall('/sobjects/Lead/', 'POST', leadData, accessToken);
      return {
        success: true,
        id: result.id,
        url: `${this.baseUrl}/lightning/r/Lead/${result.id}/view`
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.[0]?.message || error.message
      };
    }
  }

  // Create an Opportunity
  async createOpportunity(opportunityData, accessToken) {
    try {
      const result = await this.makeApiCall('/sobjects/Opportunity/', 'POST', opportunityData, accessToken);
      return {
        success: true,
        id: result.id,
        url: `${this.baseUrl}/lightning/r/Opportunity/${result.id}/view`
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.[0]?.message || error.message
      };
    }
  }

  // Create an Account
  async createAccount(accountData, accessToken) {
    try {
      const result = await this.makeApiCall('/sobjects/Account/', 'POST', accountData, accessToken);
      return {
        success: true,
        id: result.id,
        url: `${this.baseUrl}/lightning/r/Account/${result.id}/view`
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.[0]?.message || error.message
      };
    }
  }

  // Create a Case
  async createCase(caseData, accessToken) {
    try {
      const result = await this.makeApiCall('/sobjects/Case/', 'POST', caseData, accessToken);
      return {
        success: true,
        id: result.id,
        url: `${this.baseUrl}/lightning/r/Case/${result.id}/view`
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.[0]?.message || error.message
      };
    }
  }

  // Create a Contact
  async createContact(contactData, accessToken) {
    try {
      const result = await this.makeApiCall('/sobjects/Contact/', 'POST', contactData, accessToken);
      return {
        success: true,
        id: result.id,
        url: `${this.baseUrl}/lightning/r/Contact/${result.id}/view`
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.[0]?.message || error.message
      };
    }
  }

  // Create a Task
  async createTask(taskData, accessToken) {
    try {
      const result = await this.makeApiCall('/sobjects/Task/', 'POST', taskData, accessToken);
      return {
        success: true,
        id: result.id,
        url: `${this.baseUrl}/lightning/r/Task/${result.id}/view`
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.[0]?.message || error.message
      };
    }
  }

  // Query Salesforce records
  async queryRecords(soql, accessToken) {
    try {
      const encodedQuery = encodeURIComponent(soql);
      const result = await this.makeApiCall(`/query/?q=${encodedQuery}`, 'GET', null, accessToken);
      return {
        success: true,
        records: result.records,
        totalSize: result.totalSize
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.[0]?.message || error.message
      };
    }
  }

  // Update a record
  async updateRecord(objectType, recordId, updateData, accessToken) {
    try {
      const result = await this.makeApiCall(`/sobjects/${objectType}/${recordId}`, 'PATCH', updateData, accessToken);
      return {
        success: true,
        id: recordId,
        url: `${this.baseUrl}/lightning/r/${objectType}/${recordId}/view`
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.[0]?.message || error.message
      };
    }
  }

  // Get object metadata
  async getObjectMetadata(objectType, accessToken) {
    try {
      const result = await this.makeApiCall(`/sobjects/${objectType}/describe`, 'GET', null, accessToken);
      return {
        success: true,
        fields: result.fields,
        label: result.label,
        name: result.name
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.[0]?.message || error.message
      };
    }
  }
}

module.exports = new SalesforceService();
