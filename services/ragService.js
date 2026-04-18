// services/ragService.js
const crypto = require('crypto');
const axios = require('axios');
const OpenAI = require('openai');
const config = require('../config/config');
const AIServiceFactory = require('./aiServiceFactory');
const paperlessService = require('./paperlessService');

class RagService {
  constructor() {
    this.baseUrl = process.env.RAG_SERVICE_URL || 'http://localhost:8000';
    // In-memory job store for async RAG queries
    this.jobs = new Map();
    // Clean up completed jobs older than 10 minutes
    setInterval(() => this._cleanupJobs(), 60000);
  }

  _cleanupJobs() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, job] of this.jobs) {
      if (job.completedAt && job.completedAt < cutoff) {
        this.jobs.delete(id);
      }
    }
  }

  /**
   * Create an OpenAI client based on the configured AI provider.
   */
  _createLLMClient() {
    let client, model;
    if (config.aiProvider === 'custom') {
      client = new OpenAI({ baseURL: config.custom.apiUrl, apiKey: config.custom.apiKey });
      model = config.custom.model;
    } else if (config.aiProvider === 'openai') {
      client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      model = process.env.OPENAI_MODEL || 'gpt-4';
    } else if (config.aiProvider === 'ollama') {
      client = new OpenAI({ baseURL: `${process.env.OLLAMA_API_URL}/v1`, apiKey: 'ollama' });
      model = process.env.OLLAMA_MODEL;
    } else if (config.aiProvider === 'azure') {
      client = new OpenAI({
        apiKey: process.env.AZURE_API_KEY,
        baseURL: `${process.env.AZURE_ENDPOINT}/openai/deployments/${process.env.AZURE_DEPLOYMENT_NAME}`,
        defaultQuery: { 'api-version': process.env.AZURE_API_VERSION },
      });
      model = process.env.AZURE_DEPLOYMENT_NAME;
    } else {
      throw new Error('AI Provider not configured');
    }
    return { client, model };
  }

  /**
   * Start an async RAG job. Returns the job ID immediately.
   * The LLM call runs in the background.
   */
  async startAsyncJob(question) {
    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      question,
      status: 'building_prompt',
      sources: [],
      answer: null,
      error: null,
      createdAt: Date.now(),
      completedAt: null,
    };
    this.jobs.set(jobId, job);

    // Run the LLM call in the background (don't await)
    this._runAsyncJob(job).catch(err => {
      console.error(`[RAG] Async job ${jobId} failed:`, err.message);
      job.status = 'error';
      job.error = err.message;
      job.completedAt = Date.now();
    });

    return jobId;
  }

  async _runAsyncJob(job) {
    const { prompt, sources } = await this._buildRagPrompt(job.question);
    job.sources = sources;
    job.status = 'waiting_for_llm';

    const { client, model } = this._createLLMClient();
    console.log(`[RAG] Async job ${job.id}: starting LLM call (${prompt.length} chars)...`);
    const llmStart = Date.now();

    const completion = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 4096,
    });

    let rawAnswer = completion.choices[0]?.message?.content || '';
    let answer = rawAnswer.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    console.log(`[RAG] Async job ${job.id}: LLM completed in ${Date.now() - llmStart}ms, raw=${rawAnswer.length} chars, clean=${answer.length} chars`);
    if (rawAnswer.length !== answer.length) {
      console.log(`[RAG] Async job ${job.id}: think block was ${rawAnswer.length - answer.length} chars`);
    }
    console.log(`[RAG] Async job ${job.id}: answer: ${answer.substring(0, 200)}`);
    job.answer = answer;
    job.status = 'complete';
    job.completedAt = Date.now();
  }

  /**
   * Get the status/result of an async job.
   */
  getJob(jobId) {
    return this.jobs.get(jobId) || null;
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
  /**
   * Build the RAG prompt: retrieve context, fetch full document content, assemble prompt.
   * Returns { prompt, sources } for use by both streaming and non-streaming callers.
   */
  async _buildRagPrompt(question) {
    const startTime = Date.now();

    const response = await axios.post(`${this.baseUrl}/context`, {
      question,
      max_sources: 5
    });

    const { context, sources } = response.data;
    console.log(`[RAG] Context retrieval took ${Date.now() - startTime}ms, got ${sources?.length || 0} sources`);

    let enhancedContext = context;

    if (sources && sources.length > 0) {
      const fetchStart = Date.now();
      const fullDocContents = await Promise.all(
        sources.map(async (source) => {
          if (source.doc_id) {
            try {
              const fullContent = await paperlessService.getDocumentContent(source.doc_id);
              return `Full document content for ${source.title || 'Document ' + source.doc_id}:\n${fullContent}`;
            } catch (error) {
              console.error(`Error fetching content for document ${source.doc_id}:`, error.message);
              return '';
            }
          }
          return '';
        })
      );
      console.log(`[RAG] Document fetches took ${Date.now() - fetchStart}ms`);
      enhancedContext = context + '\n\n' + fullDocContents.filter(c => c).join('\n\n');
    }

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

    console.log(`[RAG] Prompt length: ${prompt.length} chars`);
    return { prompt, sources };
  }

  /**
   * Stream a RAG answer via SSE. Sends sources first, then streams LLM tokens,
   * then sends a [DONE] event.
   */
  async askQuestionStream(question, res) {
    try {
      const { prompt, sources } = await this._buildRagPrompt(question);

      // Set SSE headers — X-Accel-Buffering disables proxy buffering (nginx/traefik)
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      // Disable Nagle's algorithm so small writes flush immediately to the socket
      if (res.socket) res.socket.setNoDelay(true);

      // Send sources as the first event so the frontend can display them immediately
      res.write(`data: ${JSON.stringify({ type: 'sources', sources })}\n\n`);

      // Create a streaming OpenAI client based on the configured provider
      let client, model;
      if (config.aiProvider === 'custom') {
        client = new OpenAI({ baseURL: config.custom.apiUrl, apiKey: config.custom.apiKey });
        model = config.custom.model;
      } else if (config.aiProvider === 'openai') {
        client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        model = process.env.OPENAI_MODEL || 'gpt-4';
      } else if (config.aiProvider === 'ollama') {
        client = new OpenAI({ baseURL: `${process.env.OLLAMA_API_URL}/v1`, apiKey: 'ollama' });
        model = process.env.OLLAMA_MODEL;
      } else if (config.aiProvider === 'azure') {
        client = new OpenAI({
          apiKey: process.env.AZURE_API_KEY,
          baseURL: `${process.env.AZURE_ENDPOINT}/openai/deployments/${process.env.AZURE_DEPLOYMENT_NAME}`,
          defaultQuery: { 'api-version': process.env.AZURE_API_VERSION },
        });
        model = process.env.AZURE_DEPLOYMENT_NAME;
      } else {
        throw new Error('AI Provider not configured');
      }

      console.log(`[RAG] Starting streaming LLM call...`);
      const llmStart = Date.now();

      // Send SSE heartbeat every 10s to keep connection alive through proxies
      let hbCount = 0;
      const heartbeat = setInterval(() => {
        hbCount++;
        res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
        console.log(`[RAG] Heartbeat #${hbCount} sent at ${Date.now() - llmStart}ms`);
      }, 10000);

      const stream = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 4096,
        stream: true,
      });

      let tokenCount = 0;
      let fullResponse = '';
      try {
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || '';
          if (content) {
            tokenCount++;
            fullResponse += content;
            res.write(`data: ${JSON.stringify({ type: 'content', content })}\n\n`);
          }
        }
      } finally {
        clearInterval(heartbeat);
      }
      // Strip <think>...</think> blocks from the final response and send as a
      // replacement event so the frontend shows the clean answer
      const cleaned = fullResponse.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (cleaned !== fullResponse.trim()) {
        console.log(`[RAG] Stripped think blocks, clean response: ${cleaned.length} chars`);
        res.write(`data: ${JSON.stringify({ type: 'replace', content: cleaned })}\n\n`);
      }
      console.log(`[RAG] Streamed ${tokenCount} tokens, response: ${fullResponse.length} chars`);

      console.log(`[RAG] Streaming LLM completed in ${Date.now() - llmStart}ms`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
    } catch (error) {
      console.error('Error in askQuestionStream:', error.message);
      // If headers already sent, send error as SSE event
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: error.message || 'Internal server error' });
      }
    }
  }

  async askQuestion(question) {
    try {
      const { prompt, sources } = await this._buildRagPrompt(question);

      const aiService = AIServiceFactory.getService();
      let answer;
      try {
        answer = await aiService.generateText(prompt);
      } catch (error) {
        console.error('Error generating answer with AI service:', error);
        answer = "An error occurred while generating an answer. Please try again later.";
      }

      return { answer, sources };
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
