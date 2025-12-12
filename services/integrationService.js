const axios = require('axios');
const redisService = require('./redisService');

class IntegrationService {
  constructor() {
    this.integrations = {
      jira: this.jiraIntegration,
      github: this.githubIntegration,
      confluence: this.confluenceIntegration
    };
  }

  // Jira Integration
  jiraIntegration = async (action, params, teamId) => {
    const credentials = await redisService.getCredentials(teamId, 'jira');
    if (!credentials) {
      throw new Error('Jira credentials not configured. Please set up Jira integration first.');
    }

    const { baseUrl, username, apiToken, defaultProject } = credentials;
    const normalizedBaseUrl = (baseUrl || '').replace(/\/+$/, '');

    switch (action) {
      case 'create_ticket':
        // Resolve project key explicitly; require it
        {
          const projectKey = params.project || defaultProject;
          if (!projectKey) {
            throw new Error('No Jira project specified. Set a default project in Jira settings or include a "project" key.');
          }
          return await this.createJiraTicket(normalizedBaseUrl, username, apiToken, { ...params, project: projectKey });
        }
      case 'get_ticket':
        return await this.getJiraTicket(normalizedBaseUrl, username, apiToken, params);
      case 'search_tickets':
        return await this.searchJiraTickets(normalizedBaseUrl, username, apiToken, params);
      default:
        throw new Error(`Unknown Jira action: ${action}`);
    }
  }

  async createJiraTicket(baseUrl, username, apiToken, params) {
    try {
      const { project, summary, description, issueType = 'Task' } = params;
      if (!project) {
        throw new Error('Project key is required to create a Jira ticket.');
      }
      
      console.log('Creating Jira ticket with:', {
        baseUrl,
        username,
        project,
        summary,
        description,
        issueType
      });
      
      const response = await axios.post(
        `${baseUrl}/rest/api/2/issue`,
        {
          fields: {
            project: { key: project },
            summary: summary,
            description: description,
            issuetype: { name: issueType }
          }
        },
        {
          auth: {
            username: username,
            password: apiToken
          },
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        }
      );

      console.log('Jira ticket created successfully:', response.data);

      return {
        success: true,
        ticketKey: response.data.key,
        ticketUrl: `${baseUrl}/browse/${response.data.key}`,
        message: `Created Jira ticket ${response.data.key} in project ${project}: ${summary}`
      };
    } catch (error) {
      const data = error.response?.data;
      let details = '';

      if (Array.isArray(data?.errorMessages) && data.errorMessages.length) {
        details = data.errorMessages.join(', ');
      } else if (data?.errors && Object.keys(data.errors).length) {
        details = Object.entries(data.errors).map(([field, msg]) => `${field}: ${msg}`).join(', ');
      } else if (typeof data === 'string' && data.trim()) {
        details = data.trim();
      } else if (data?.message) {
        details = data.message;
      } else if (error.response?.status) {
        details = `HTTP ${error.response.status} ${error.response.statusText || ''}`.trim();
      } else if (error.message) {
        details = error.message;
      } else {
        details = 'Unknown error';
      }

      console.error('Error creating Jira ticket:', data || error.message);
      throw new Error(`Failed to create Jira ticket: ${details}`);
    }
  }

  async getJiraTicket(baseUrl, username, apiToken, params) {
    try {
      const { ticketKey } = params;
      
      const response = await axios.get(
        `${baseUrl}/rest/api/3/issue/${ticketKey}`,
        {
          auth: {
            username: username,
            password: apiToken
          }
        }
      );

      const issue = response.data;
      return {
        success: true,
        ticket: {
          key: issue.key,
          summary: issue.fields.summary,
          description: issue.fields.description,
          status: issue.fields.status.name,
          assignee: issue.fields.assignee?.displayName || 'Unassigned',
          url: `${baseUrl}/browse/${issue.key}`
        }
      };
    } catch (error) {
      console.error('Error getting Jira ticket:', error.response?.data || error.message);
      throw new Error(`Failed to get Jira ticket: ${error.response?.data?.errorMessages?.join(', ') || error.message}`);
    }
  }

  async searchJiraTickets(baseUrl, username, apiToken, params) {
    try {
      const { jql, maxResults = 10 } = params;
      
      const response = await axios.post(
        `${baseUrl}/rest/api/3/search`,
        {
          jql: jql,
          maxResults: maxResults,
          fields: ['key', 'summary', 'status', 'assignee']
        },
        {
          auth: {
            username: username,
            password: apiToken
          },
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      const tickets = response.data.issues.map(issue => ({
        key: issue.key,
        summary: issue.fields.summary,
        status: issue.fields.status.name,
        assignee: issue.fields.assignee?.displayName || 'Unassigned',
        url: `${baseUrl}/browse/${issue.key}`
      }));

      return {
        success: true,
        tickets: tickets,
        total: response.data.total
      };
    } catch (error) {
      console.error('Error searching Jira tickets:', error.response?.data || error.message);
      throw new Error(`Failed to search Jira tickets: ${error.response?.data?.errorMessages?.join(', ') || error.message}`);
    }
  }

  // GitHub Integration (placeholder)
  githubIntegration = async (action, params, teamId) => {
    const credentials = await redisService.getCredentials(teamId, 'github');
    if (!credentials) {
      throw new Error('GitHub credentials not configured. Please set up GitHub integration first.');
    }

    // TODO: Implement GitHub integration
    throw new Error('GitHub integration not yet implemented');
  }

  // Confluence Integration (placeholder)
  confluenceIntegration = async (action, params, teamId) => {
    const credentials = await redisService.getCredentials(teamId, 'confluence');
    if (!credentials) {
      throw new Error('Confluence credentials not configured. Please set up Confluence integration first.');
    }

    // TODO: Implement Confluence integration
    throw new Error('Confluence integration not yet implemented');
  }

  // Main integration handler
  async handleIntegration(integrationType, action, params, teamId) {
    if (!this.integrations[integrationType]) {
      throw new Error(`Integration type '${integrationType}' not supported`);
    }

    return await this.integrations[integrationType](action, params, teamId);
  }

  // Get available integrations
  getAvailableIntegrations() {
    return Object.keys(this.integrations);
  }

  // Validate credentials for an integration
  async validateCredentials(integrationType, credentials, teamId) {
    try {
      switch (integrationType) {
        case 'jira':
          return await this.validateJiraCredentials(credentials);
        case 'github':
          return await this.validateGitHubCredentials(credentials);
        case 'confluence':
          return await this.validateConfluenceCredentials(credentials);
        default:
          throw new Error(`Unknown integration type: ${integrationType}`);
      }
    } catch (error) {
      console.error(`Error validating ${integrationType} credentials:`, error);
      return false;
    }
  }

  async validateJiraCredentials(credentials) {
    try {
      const { baseUrl, username, apiToken } = credentials;
      
      const response = await axios.get(
        `${baseUrl}/rest/api/2/myself`,
        {
          auth: {
            username: username,
            password: apiToken
          }
        }
      );

      return response.status === 200;
    } catch (error) {
      console.error('Jira credentials validation failed:', error.response?.data || error.message);
      return false;
    }
  }

  async validateGitHubCredentials(credentials) {
    // TODO: Implement GitHub credentials validation
    return false;
  }

  async validateConfluenceCredentials(credentials) {
    // TODO: Implement Confluence credentials validation
    return false;
  }
}

module.exports = new IntegrationService();
