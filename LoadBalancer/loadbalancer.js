// app.js
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const ejs = require('ejs');
// const { Redis } = require('@upstash/redis'); // REMOVE this line
const Redis = require('ioredis'); // ADD this line to import ioredis
require('dotenv').config();

const app = express();

// --- Middleware ---
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.use(bodyParser.json());
app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');

// --- Redis Connection ---

// Connect to Redis using the full connection URL from Railway
// Store this URL in your .env file as REDIS_URL
const redis = new Redis(process.env.REDIS_URL); // Use the full URL directly

// Add an error listener for ioredis to catch connection issues
redis.on('error', (err) => {
  console.error('Redis connection error:', err);
  // Depending on your application's needs, you might want to
  // implement more robust error handling here, e.g., graceful shutdown
  // or retry mechanisms.
});

redis.on('connect', () => {
  console.log('Successfully connected to Redis!');
});


// --- Redis Utility Functions ---

/**
 * Ensures the 'apiPool' hash in Redis is initialized and contains valid JSON data.
 * If 'apiPool' does not exist, it's initialized as an empty hash.
 * It iterates through existing entries, attempting to parse them. If parsing fails
 * or the parsed data is not a valid object, the entry is removed from 'apiPool'.
 */
async function ensureApiPool() {
  console.log('Ensuring apiPool integrity...');
  try {
    // For ioredis, .exists() takes a single key, not multiple.
    // To check if a hash exists, you can try to get a field from it,
    // or use TYPE command if you need to be sure it's a HASH.
    // For simplicity, we'll assume if hgetall returns null, it doesn't exist.
    let apiPoolData = await redis.hgetall('apiPool');

    if (!apiPoolData || Object.keys(apiPoolData).length === 0) {
      console.log('apiPool does not exist or is empty, initializing.');
      // No explicit HSET needed here, the first add-api will create the hash.
      // We can optionally add a dummy key to ensure it's a hash from the start
      // but the `seedInitialApi` or `add-api` should handle this.
      return;
    }

    for (const [id, dataStr] of Object.entries(apiPoolData)) {
      if (typeof dataStr !== 'string' || dataStr.trim() === '') {
        console.warn(`Removing invalid (non-string or empty) data for API ID ${id}.`);
        await redis.hdel('apiPool', id);
        continue;
      }
      try {
        const parsedData = JSON.parse(dataStr);
        if (typeof parsedData !== 'object' || parsedData === null ||
            !parsedData.apiKey || !parsedData.characterId || typeof parsedData.maxSessions !== 'number' || parsedData.maxSessions <= 0) {
          throw new Error('Invalid API data structure or missing required fields.');
        }
      } catch (e) {
        console.error(`Removing invalid data for API ID ${id}: ${e.message}. Data was: "${dataStr}"`);
        await redis.hdel('apiPool', id);
      }
    }
    console.log('apiPool integrity check complete.');
  } catch (error) {
    console.error('Error during ensureApiPool:', error);
  }
}

/**
 * Seeds an initial API configuration into Redis if it doesn't already exist.
 * This ensures a default API is available on server startup.
 */
async function seedInitialApi() {
  const apiId = '1';
  const apiKey = 'd0cb7e13755411b19bf931139e028bde';
  const characterId = 'c29f49b8-3b46-11f0-b6c9-42010a7be01f';
  const maxSessions = 5; // Default max sessions for this seeded API

  console.log(`Attempting to seed initial API: ${apiId}`);
  try {
    // For ioredis, hexists works the same
    const exists = await redis.hexists('apiPool', apiId);
    if (exists) {
      console.log(`Initial API ${apiId} already exists in apiPool. Skipping seeding.`);
      return;
    }

    const apiData = { apiKey, characterId, maxSessions };
    await redis.hset('apiPool', apiId, JSON.stringify(apiData));
    await redis.set(`api:${apiId}:sessions`, 0);
    await redis.set(`api:${apiId}:closedSessions`, 0);
    await redis.sadd(`api:${apiId}:users`, 'dummy_init_value');
    await redis.srem(`api:${apiId}:users`, 'dummy_init_value');

    console.log(`Successfully seeded initial API: ${apiId}.`);
  } catch (error) {
    console.error(`Error seeding initial API ${apiId}:`, error);
  }
}


// Call ensureApiPool and seedInitialApi on application startup using an IIFE
(async () => {
  await ensureApiPool();
  await seedInitialApi();
})();

/**
 * Finds the first available API from the apiPool based on session limits.
 * @returns {Promise<Object|null>} An object containing the API's id and its data, or null if no API is available.
 */
async function getAvailableAPI() {
  console.log('Checking for available APIs...');
  let apiPoolData = await redis.hgetall('apiPool');
  if (!apiPoolData) apiPoolData = {};

  for (const [id, dataStr] of Object.entries(apiPoolData)) {
    if (typeof dataStr !== 'string' || dataStr.trim() === '') {
      console.warn(`Skipping API ID ${id} due to invalid or empty data string.`);
      continue;
    }
    try {
      const data = JSON.parse(dataStr);
      if (typeof data !== 'object' || data === null || typeof data.maxSessions !== 'number' || data.maxSessions <= 0) {
        console.warn(`Skipping API ID ${id} due to malformed data after parsing.`);
        continue;
      }

      const count = Number(await redis.get(`api:${id}:sessions`) || 0);
      if (count < data.maxSessions) {
        console.log(`API ${id} is available with ${count} sessions out of ${data.maxSessions}.`);
        return { id, ...data };
      }
    } catch (e) {
      console.error(`Error parsing data for API ID ${id} in getAvailableAPI: ${e.message}. Data was: "${dataStr}"`);
    }
  }
  console.log('All APIs are at max capacity or no valid APIs found.');
  return null;
}

/**
 * Helper function to fetch monitoring data for all APIs.
 * This is used by the dashboard route and the monitoring API endpoint.
 * @returns {Promise<Array<Object>>} An array of API monitoring objects.
 */
async function fetchMonitoringData() {
  let apiPoolData = await redis.hgetall('apiPool');
  if (!apiPoolData) apiPoolData = {};
  const monitoring = [];

  for (const [id, dataStr] of Object.entries(apiPoolData)) {
    if (typeof dataStr !== 'string' || dataStr.trim() === '') {
      console.warn(`Skipping monitoring for API ID ${id} due to invalid or empty data string.`);
      continue;
    }
    try {
      const data = JSON.parse(dataStr);
      if (typeof data !== 'object' || data === null ||
          typeof data.apiKey !== 'string' || data.apiKey.trim() === '' ||
          typeof data.characterId !== 'string' || data.characterId.trim() === '' ||
          typeof data.maxSessions !== 'number' || data.maxSessions <= 0) {
        throw new Error('Invalid API data structure or missing/invalid required fields.');
      }

      const activeSessionsKey = `api:${id}:sessions`;
      const activeCount = Number(await redis.get(activeSessionsKey) || 0);
      const closedSessionsKey = `api:${id}:closedSessions`;
      const closedCount = Number(await redis.get(closedSessionsKey) || 0);

      monitoring.push({
        id,
        apiKey: data.apiKey,
        characterId: data.characterId,
        maxSessions: data.maxSessions,
        activeCount,
        closedCount
      });
    } catch (e) {
      console.error(`Error processing monitoring data for API ID ${id}: ${e.message}. Data was: "${dataStr}"`);
    }
  }
  return monitoring;
}

// --- API Endpoints ---

app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

app.post('/api/get-api-session', async (req, res) => {
  const { userId } = req.body;

  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    return res.status(400).json({ message: 'Invalid input: userId is required and must be a non-empty string.' });
  }

  try {
    const existingSessionStr = await redis.get(`user:${userId}`);

    if (existingSessionStr) {
      try {
        const sessionData = JSON.parse(existingSessionStr);
        if (typeof sessionData !== 'object' || sessionData === null ||
            typeof sessionData.apiId !== 'string' || sessionData.apiId.trim() === '' ||
            typeof sessionData.apiKey !== 'string' || sessionData.apiKey.trim() === '' ||
            typeof sessionData.characterId !== 'string' || sessionData.characterId.trim() === '') {
          throw new Error('Malformed existing session data in Redis.');
        }
        console.log(`User ${userId} already has an active session with API ${sessionData.apiId}.`);
        return res.json({
          apiId: sessionData.apiId,
          apiKey: sessionData.apiKey,
          characterId: sessionData.characterId
        });
      } catch (e) {
        console.error(`Error parsing existing session data for user ${userId}: ${e.message}. Data was: "${existingSessionStr}"`);
        await redis.del(`user:${userId}`);
      }
    }

    const targetAPI = await getAvailableAPI();
    if (!targetAPI) {
      console.log(`User ${userId} could not get a session: All APIs at max capacity.`);
      return res.status(503).json({ message: 'All APIs are at max capacity. Try again later.' });
    }

    const sessionDataToStore = {
      apiId: targetAPI.id,
      apiKey: targetAPI.apiKey,
      characterId: targetAPI.characterId
    };

    const SESSION_TTL = 60 * 15;
    await redis.set(`user:${userId}`, JSON.stringify(sessionDataToStore), 'EX', SESSION_TTL);
    await redis.incr(`api:${targetAPI.id}:sessions`);
    await redis.sadd(`api:${targetAPI.id}:users`, userId);

    console.log(`Assigned API ${targetAPI.id} to user ${userId}.`);
    res.json(sessionDataToStore);
  } catch (error) {
    console.error('Error in /api/get-api-session:', error);
    res.status(500).json({ message: 'Internal Server Error during session assignment.' });
  }
});

app.post('/api/end-session', async (req, res) => {
  const { userId } = req.body;

  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    return res.status(400).json({ message: 'Invalid input: userId is required and must be a non-empty string.' });
  }

  try {
    const sessionDataStr = await redis.get(`user:${userId}`);
    if (!sessionDataStr) {
      return res.status(404).json({ message: 'No active session found for this user.' });
    }

    let session;
    try {
      session = JSON.parse(sessionDataStr);
      if (typeof session !== 'object' || session === null || typeof session.apiId !== 'string' || session.apiId.trim() === '') {
        throw new Error('Malformed session data in Redis.');
      }
    } catch (e) {
      console.error(`Error parsing session data for user ${userId} during end-session: ${e.message}. Data was: "${sessionDataStr}"`);
      await redis.del(`user:${userId}`);
      return res.status(500).json({ message: 'Internal Server Error: Corrupt session data. Session cleared.' });
    }

    const currentSessions = Number(await redis.get(`api:${session.apiId}:sessions`) || 0);
    if (currentSessions > 0) {
      await redis.decr(`api:${session.apiId}:sessions`);
    } else {
      console.warn(`Attempted to decrement sessions for API ${session.apiId} but count was already 0.`);
    }

    await redis.del(`user:${userId}`);
    await redis.srem(`api:${session.apiId}:users`, userId);
    await redis.incr(`api:${session.apiId}:closedSessions`);

    console.log(`[${session.apiId}] Ended session for user ${userId}.`);
    res.json({ message: 'Session ended successfully.' });
  } catch (error) {
    console.error('Error in /api/end-session:', error);
    res.status(500).json({ message: 'Internal Server Error during session termination.' });
  }
});

app.post('/api/add-api', async (req, res) => {
  const { apiId, apiKey, characterId, maxSessions } = req.body;

  if (!apiId || typeof apiId !== 'string' || apiId.trim() === '' ||
      !apiKey || typeof apiKey !== 'string' || apiKey.trim() === '' ||
      !characterId || typeof characterId !== 'string' || characterId.trim() === '' ||
      typeof maxSessions !== 'number' || maxSessions <= 0) {
    console.warn('Rejected /api/add-api payload due to invalid input:', req.body);
    return res.status(400).json({
      message: 'Invalid input: apiId, apiKey, characterId are required non-empty strings, and maxSessions must be a positive number.'
    });
  }

  try {
    const exists = await redis.hexists('apiPool', apiId);
    if (exists) {
      return res.status(400).json({ message: `API with ID '${apiId}' already exists.` });
    }

    const apiData = { apiKey, characterId, maxSessions };
    await redis.hset('apiPool', apiId, JSON.stringify(apiData));

    await redis.set(`api:${apiId}:sessions`, 0);
    await redis.set(`api:${apiId}:closedSessions`, 0);
    await redis.sadd(`api:${apiId}:users`, 'dummy_init_value');
    await redis.srem(`api:${apiId}:users`, 'dummy_init_value');

    console.log(`API added: ID ${apiId}, Character ID ${characterId}, Max Sessions: ${maxSessions}`);
    res.status(201).json({ message: 'API added successfully.', api: { id: apiId, ...apiData } });
  } catch (error) {
    console.error('Error in /api/add-api:', error);
    res.status(500).json({ message: 'Internal Server Error during API addition.' });
  }
});

app.post('/api/update-api', async (req, res) => {
  const { apiId, apiKey, characterId, maxSessions } = req.body;

  if (!apiId || typeof apiId !== 'string' || apiId.trim() === '') {
    return res.status(400).json({ message: 'Invalid input: apiId is required and must be a non-empty string.' });
  }

  try {
    const existingApiDataStr = await redis.hget('apiPool', apiId);
    if (!existingApiDataStr) {
      return res.status(404).json({ message: `API with ID '${apiId}' not found.` });
    }

    let existingApiData;
    try {
      existingApiData = JSON.parse(existingApiDataStr);
      if (typeof existingApiData !== 'object' || existingApiData === null) {
        throw new Error('Malformed existing API data in Redis.');
      }
    } catch (e) {
      console.error(`Error parsing existing API data for ID ${apiId} during update: ${e.message}. Data was: "${existingApiDataStr}"`);
      return res.status(500).json({ message: 'Internal Server Error: Corrupt API data. Cannot update.' });
    }

    const updatedApiData = {
      apiKey: apiKey && typeof apiKey === 'string' && apiKey.trim() !== '' ? apiKey.trim() : existingApiData.apiKey,
      characterId: characterId && typeof characterId === 'string' && characterId.trim() !== '' ? characterId.trim() : existingApiData.characterId,
      maxSessions: typeof maxSessions === 'number' && maxSessions > 0 ? maxSessions : existingApiData.maxSessions
    };

    if (!updatedApiData.apiKey || !updatedApiData.characterId || typeof updatedApiData.maxSessions !== 'number' || updatedApiData.maxSessions <= 0) {
      console.warn('Rejected /api/update-api payload due to invalid resulting API data:', updatedApiData);
      return res.status(400).json({
        message: 'Invalid input: apiKey, characterId must be non-empty strings, and maxSessions must be a positive number if provided for update.'
      });
    }

    await redis.hset('apiPool', apiId, JSON.stringify(updatedApiData));
    console.log(`API updated: ID ${apiId}. New data:`, updatedApiData);
    res.json({ message: 'API updated successfully.', api: { id: apiId, ...updatedApiData } });
  } catch (error) {
    console.error('Error in /api/update-api:', error);
    res.status(500).json({ message: 'Internal Server Error during API update.' });
  }
});

app.delete('/api/remove-api', async (req, res) => {
  const { apiId } = req.body;

  if (!apiId || typeof apiId !== 'string' || apiId.trim() === '') {
    return res.status(400).json({ message: 'Invalid input: apiId is required and must be a non-empty string.' });
  }

  try {
    const exists = await redis.hexists('apiPool', apiId);
    if (!exists) {
      return res.status(404).json({ message: `API with ID '${apiId}' not found.` });
    }

    await redis.hdel('apiPool', apiId);
    await redis.del(`api:${apiId}:sessions`);
    await redis.del(`api:${apiId}:closedSessions`);
    await redis.del(`api:${apiId}:users`);

    console.log(`API removed: ID ${apiId}.`);
    res.json({ message: 'API removed successfully.' });
  } catch (error) {
    console.error('Error in /api/remove-api:', error);
    res.status(500).json({ message: 'Internal Server Error during API removal.' });
  }
});

// --- Monitoring Endpoints ---

app.get('/api/monitoring', async (req, res) => {
  try {
    const monitoringData = await fetchMonitoringData();
    res.json(monitoringData);
  } catch (error) {
    console.error('Error in /api/monitoring:', error);
    res.status(500).json({ message: 'Internal Server Error fetching monitoring data.' });
  }
});

app.get('/dashboard', async (req, res) => {
  try {
    const apiPoolData = await redis.hgetall('apiPool');
    const apis = Object.entries(apiPoolData || {}).map(([id, dataStr]) => {
      if (typeof dataStr === 'string' && dataStr.trim() !== '') {
        try {
          const parsedData = JSON.parse(dataStr);
          return { id, ...parsedData };
        } catch (e) {
          console.error(`Error parsing API data for dashboard ID ${id}: ${e.message}. Data was: "${dataStr}"`);
          return { id, error: 'Invalid data format' };
        }
      }
      return { id, error: 'No data or empty string' };
    });

    const monitoringData = await fetchMonitoringData();
    res.render('dashboard', { apis, monitoring: monitoringData });
  } catch (error) {
    console.error('Error rendering dashboard:', error);
    res.status(500).send('Error loading dashboard.');
  }
});

// --- Start Server ---

const PORT = process.env.PORT || 3007;
app.listen(PORT, () => {
  console.log(`🚀 Load balancer running at http://localhost:${PORT}`);
  console.log('Ensure REDIS_URL is set in your .env file for Railway Redis connection.');
});
