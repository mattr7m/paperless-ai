// routes/rag.js
const express = require('express');
const router = express.Router();
const ragService = require('../services/ragService');

/**
 * Search documents
 */
router.post('/search', async (req, res) => {
  try {
    const { query, from_date, to_date, correspondent } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }
    
    const filters = {};
    if (from_date) filters.from_date = from_date;
    if (to_date) filters.to_date = to_date;
    if (correspondent) filters.correspondent = correspondent;
    
    const results = await ragService.search(query, filters);
    res.json(results);
  } catch (error) {
    console.error('Error in /api/rag/search:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Ask a question about documents (non-streaming, kept for compatibility)
 */
router.post('/ask', async (req, res) => {
  try {
    const { question } = req.body;

    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }

    const result = await ragService.askQuestion(question);
    res.json(result);
  } catch (error) {
    console.error('Error in /api/rag/ask:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Start an async RAG job (returns job ID immediately)
 */
router.post('/ask/async', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }
    const jobId = await ragService.startAsyncJob(question);
    res.json({ jobId });
  } catch (error) {
    console.error('Error in /api/rag/ask/async:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Poll for async RAG job status/result
 */
router.get('/ask/status/:jobId', async (req, res) => {
  try {
    const job = ragService.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json({
      status: job.status,
      sources: job.sources,
      answer: job.answer,
      error: job.error,
      elapsed: Date.now() - job.createdAt,
    });
  } catch (error) {
    console.error('Error in /api/rag/ask/status:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Ask a question about documents (streaming SSE)
 */
router.post('/ask/stream', async (req, res) => {
  try {
    const { question } = req.body;

    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }

    await ragService.askQuestionStream(question, res);
  } catch (error) {
    console.error('Error in /api/rag/ask/stream:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }
});

/**
 * Start document indexing
 */
router.post('/index', async (req, res) => {
  try {
    const { force = false } = req.body;
    const result = await ragService.indexDocuments(force);
    res.json(result);
  } catch (error) {
    console.error('Error in /api/rag/index:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Get indexing status
 */
router.get('/index/status', async (req, res) => {
  try {
    const status = await ragService.getIndexingStatus();
    res.json(status);
  } catch (error) {
    console.error('Error in /api/rag/index/status:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Check if updates are needed
 */
router.get('/index/check', async (req, res) => {
  try {
    const result = await ragService.checkForUpdates();
    res.json(result);
  } catch (error) {
    console.error('Error in /api/rag/index/check:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Get RAG service status
 */
router.get('/status', async (req, res) => {
  try {
    const status = await ragService.checkStatus();
    const aiStatus = await ragService.getAIStatus();
    // Combine RAG and AI status
    status.ai_status = aiStatus.status;
    status.ai_model = aiStatus.model;
    // console.log('RAG Status:', status);
    // console.log('AI Status:', aiStatus);
    res.json(status);
  } catch (error) {
    console.error('Error in /api/rag/status:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Initialize RAG service
 */
router.post('/initialize', async (req, res) => {
  try {
    const { force = false } = req.body;
    const result = await ragService.initialize(force);
    res.json(result);
  } catch (error) {
    console.error('Error in /api/rag/initialize:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

module.exports = router;
