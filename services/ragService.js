// services/ragService.js
const axios = require('axios');
const config = require('../config/config');
const AIServiceFactory = require('./aiServiceFactory');
const paperlessService = require('./paperlessService');

class RagService {
  constructor() {
    this.baseUrl = process.env.RAG_SERVICE_URL || 'http://localhost:8000';
  }

  /**
   * Check if the RAG service is available and ready
   * @returns {Promise<{status: string, index_ready: boolean, data_loaded: boolean}>}
   */
  async checkStatus() {
    try {
      const response = await axios.get(`${this.baseUrl}/status`);
      //make test call to the LLM service to check if it is available
      return response.data;
    } catch (error) {
      console.error('Error checking RAG service status:', error.message);
      return {
        server_up: false,
        data_loaded: false,
        index_ready: false,
        error: error.message
      };
    }
  }

  /**
   * Search for documents matching a query
   * @param {string} query - The search query
   * @param {Object} filters - Optional filters for search
   * @returns {Promise<Array>} - Array of search results
   */
  async search(query, filters = {}) {
    try {
      const response = await axios.post(`${this.baseUrl}/search`, {
        query,
        ...filters
      });
      return response.data;
    } catch (error) {
      console.error('Error searching documents:', error);
      throw error;
    }
  }

  /**
   * Ask a question about documents and get an AI-generated answer in the same language as the question
   * @param {string} question - The question to ask
   * @returns {Promise<{answer: string, sources: Array}>} - AI response and source documents
   */
  async askQuestion(question) {
    try {
      const startTime = Date.now();

      // 1. Get context from the RAG service
      const response = await axios.post(`${this.baseUrl}/context`, {
        question,
        max_sources: 5
      });

      const { context, sources } = response.data;
      console.log(`[RAG] Context retrieval took ${Date.now() - startTime}ms, got ${sources?.length || 0} sources`);

      // 2. Fetch full content for each source document using doc_id
      let enhancedContext = context;

      if (sources && sources.length > 0) {
        const fetchStart = Date.now();
        // Fetch full document content for each source
        const fullDocContents = await Promise.all(
          sources.map(async (source) => {
            if (source.doc_id) {
              try {
                const docStart = Date.now();
                const fullContent = await paperlessService.getDocumentContent(source.doc_id);
                console.log(`[RAG] Fetched doc ${source.doc_id} in ${Date.now() - docStart}ms (${fullContent?.length || 0} chars)`);
                return `Full document content for ${source.title || 'Document ' + source.doc_id}:\n${fullContent}`;
              } catch (error) {
                console.error(`Error fetching content for document ${source.doc_id}:`, error.message);
                return '';
              }
            }
            return '';
          })
        );
        console.log(`[RAG] All document fetches took ${Date.now() - fetchStart}ms`);

        // Combine original context with full document contents
        enhancedContext = context + '\n\n' + fullDocContents.filter(content => content).join('\n\n');
      }

      // 3. Use AI service to generate an answer based on the enhanced context
      const aiService = AIServiceFactory.getService();

      // Create a language-agnostic prompt that works in any language
      const prompt = `
        You are a helpful assistant that answers questions about documents.

        Answer the following question precisely, based on the provided documents:

        Question: ${question}

        Context from relevant documents:
        ${enhancedContext}

        Important instructions:
        - Use ONLY information from the provided documents
        - If the answer is not contained in the documents, respond: "This information is not contained in the documents." (in the same language as the question)
        - Avoid assumptions or speculation beyond the given context
        - Answer in the same language as the question was asked
        - Do not mention document numbers or source references, answer as if it were a natural conversation
        `;

      console.log(`[RAG] Prompt length: ${prompt.length} chars, calling LLM...`);
      const llmStart = Date.now();
      let answer;
      try {
        answer = await aiService.generateText(prompt);
        console.log(`[RAG] LLM response took ${Date.now() - llmStart}ms`);
      } catch (error) {
        console.error(`[RAG] LLM error after ${Date.now() - llmStart}ms:`, error.message);
        answer = "An error occurred while generating an answer. Please try again later.";
      }

      console.log(`[RAG] Total askQuestion took ${Date.now() - startTime}ms`);
      return {
        answer,
        sources
      };
    } catch (error) {
      console.error('Error in askQuestion:', error);
      throw new Error("An error occurred while processing your question. Please try again later.");
    }
  }

  /**
   * Start indexing documents in the RAG service
   * @param {boolean} force - Whether to force refresh from source
   * @returns {Promise<Object>} - Indexing status
   */
  async indexDocuments(force = false) {
    try {
      const response = await axios.post(`${this.baseUrl}/indexing/start`, { 
        force, 
        background: true 
      });
      return response.data;
    } catch (error) {
      console.error('Error indexing documents:', error);
      throw error;
    }
  }

  /**
   * Check if the RAG service needs document updates
   * @returns {Promise<{needs_update: boolean, message: string}>}
   */
  async checkForUpdates() {
    try {
      const response = await axios.post(`${this.baseUrl}/indexing/check`);
      return response.data;
    } catch (error) {
      console.error('Error checking for updates:', error);
      throw error;
    }
  }

  /**
   * Get current indexing status
   * @returns {Promise<Object>} - Current indexing status
   */
  async getIndexingStatus() {
    try {
      const response = await axios.get(`${this.baseUrl}/indexing/status`);
      return response.data;
    } catch (error) {
      console.error('Error getting indexing status:', error);
      throw error;
    }
  }

  /**
   * Initialize the RAG service
   * @param {boolean} force - Whether to force initialization
   * @returns {Promise<Object>} - Initialization status
   */
  async initialize(force = false) {
    try {
      const response = await axios.post(`${this.baseUrl}/initialize`, { force });
      return response.data;
    } catch (error) {
      console.error('Error initializing RAG service:', error);
      throw error;
    }
  }

  /**
   * Get AI status
   * @returns {Promise<{status: string}>}
   */
  async getAIStatus() {
    try {
      const aiService = AIServiceFactory.getService();
      const status = await aiService.checkStatus();
      return status;
    } catch (error) {
      console.error('Error checking AI service status:', error);
      throw error;
    }
  }
}


module.exports = new RagService();
