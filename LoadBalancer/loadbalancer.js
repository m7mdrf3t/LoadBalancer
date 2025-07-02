const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const { createClient } = require('redis');
const ejs = require('ejs');

const app = express();

// Add CORS middleware at the top
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.use(bodyParser.json());
app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');

// Connect to Redis
const redis = createClient(); // default: localhost:6379
redis.connect().catch(console.error);

// Configuration
const MAX_SESSIONS = 1;
const SESSION_TTL = 60 * 15; // 15 minutes in seconds

// API pool with one character ID per API
const apiPool = [
  {
    id: 'api1',
    apiKey: 'API_KEY_1',
    characterId: 'char1',
  },
  {
    id: 'api2',
    apiKey: 'API_KEY_2',
    characterId: 'char2',
  },
];

// Helper to find first available API
async function getAvailableAPI() {
  console.log('Checking available APIs...'); // Debugging log
  const apiPoolData = await redis.hGetAll('apiPool');
  for (const [id, dataStr] of Object.entries(apiPoolData)) {
    const data = JSON.parse(dataStr);
    const count = await redis.get(`api:${id}:sessions`) || 0;
    if (Number(count) < data.maxSessions) {
      console.log(`API ${id} is available with ${count} sessions out of ${data.maxSessions}`);
      return { id, ...data };
    }
  }
  console.log('All APIs at max capacity');
  return null;
}

// Assign session to user
app.post('/api/get-api-session', async (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ message: 'userId is required' });
  }
  const existingSession = await redis.get(`user:${userId}`);
  if (existingSession) {
    const sessionData = JSON.parse(existingSession);
    const targetAPI = await redis.hGet('apiPool', sessionData.apiId);
    const parsedTargetAPI = JSON.parse(targetAPI);
    return res.json({ apiId: sessionData.apiId, apiKey: parsedTargetAPI.apiKey, characterId: sessionData.characterId }); // Include apiKey for existing sessions as well
  }
  const targetAPI = await getAvailableAPI();
  if (!targetAPI) {
    return res.status(503).json({ message: 'All APIs are at max capacity. Try again later.' });
  }
  const sessionData = { apiId: targetAPI.id, apiKey: targetAPI.apiKey, characterId: targetAPI.characterId }; // Add apiKey to session data
  await redis.set(`user:${userId}`, JSON.stringify(sessionData), 'EX', 30); // Keep TTL as 30 seconds
  await redis.incr(`api:${targetAPI.id}:sessions`);
  await redis.sAdd(`api:${targetAPI.id}:users`, userId);
  res.json(sessionData); // Return session data with apiKey
});

// End session manually
app.post('/api/end-session', async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ message: 'userId is required' });
  }

  const sessionData = await redis.get(`user:${userId}`);
  if (!sessionData) {
    return res.status(404).json({ message: 'No active session found for this user.' });
  }

  const session = JSON.parse(sessionData);

  // Decrement active session count
  await redis.decr(`api:${session.apiId}:sessions`);

  // Remove user session
  await redis.del(`user:${userId}`);

  // Log closed session
  const closedSessionsKey = `api:${session.apiId}:closedSessions`;
  await redis.incr(closedSessionsKey);

  console.log(`[${session.apiId}] Ended session for ${userId}.`);

  res.json({ message: 'Session ended successfully.' });
});

// API Management Endpoints
app.post('/api/add-api', async (req, res) => {
  const { apiId, apiKey, characterId, maxSessions = 5, ttl = 900 } = req.body;
  if (!apiId || !apiKey || !characterId) {
    return res.status(400).json({ message: 'apiId, apiKey, and characterId are required' });
  }
  const exists = await redis.hExists('apiPool', apiId);
  if (exists) {
    return res.status(400).json({ message: 'API with this ID already exists' });
  }
  const apiData = { apiKey, characterId, maxSessions, ttl };
  await redis.hSet('apiPool', apiId, JSON.stringify(apiData));
  await redis.set(`api:${apiId}:sessions`, 0);
  await redis.set(`api:${apiId}:closedSessions`, 0);
  console.log(`API added: ID ${apiId}, Key ${apiKey}, Character ID ${characterId}, Max Sessions: ${maxSessions}`);
  res.json({ message: 'API added successfully' });
});

app.post('/api/update-api', async (req, res) => {
  const { apiId, apiKey, characterId } = req.body;
  if (!apiId) {
    return res.status(400).json({ message: 'apiId is required' });
  }
  const exists = await redis.hExists('apiPool', apiId);
  if (!exists) {
    return res.status(404).json({ message: 'API not found' });
  }
  await redis.hSet('apiPool', apiId, JSON.stringify({ apiKey, characterId }));
  res.json({ message: 'API updated successfully' });
});

app.delete('/api/remove-api', async (req, res) => {
  const { apiId } = req.body;
  if (!apiId) {
    return res.status(400).json({ message: 'apiId is required' });
  }
  const exists = await redis.hExists('apiPool', apiId);
  if (!exists) {
    return res.status(404).json({ message: 'API not found' });
  }
  await redis.hDel('apiPool', apiId);
  res.json({ message: 'API removed successfully' });
});

// Monitoring Endpoints
app.get('/api/monitoring', async (req, res) => {
  // Fetch all APIs from Redis
  const apiPoolData = await redis.hGetAll('apiPool');
  const apis = {};
  for (const [id, data] of Object.entries(apiPoolData)) {
    const parsedData = JSON.parse(data);
    const activeSessionsKey = `api:${id}:sessions`;
    const activeCount = Number(await redis.get(activeSessionsKey) || 0);
    const maxSessions = 5; // Hardcoded for now, can be made dynamic
    const ttl = 900; // Hardcoded TTL in seconds, can be fetched or set per API
    const closedSessionsKey = `api:${id}:closedSessions`;
    const closedCount = Number(await redis.get(closedSessionsKey) || 0);
    apis[id] = { activeCount, closedCount, maxSessions, ttl, ...parsedData };
  }
  res.json(apis);
});

// Update dashboard route to include monitoring data
app.get('/dashboard', async (req, res) => {
  const apiPoolData = await redis.hGetAll('apiPool');
  const apis = Object.entries(apiPoolData).map(([id, data]) => ({ id, ...JSON.parse(data) }));
  const monitoringData = await fetchMonitoringData();
  res.render('dashboard', { apis, monitoring: monitoringData });
});

// Helper function for monitoring data
async function fetchMonitoringData() {
  const apiPoolData = await redis.hGetAll('apiPool');
  const monitoring = [];
  for (const [id, dataStr] of Object.entries(apiPoolData)) {
    const data = JSON.parse(dataStr);
    const activeSessionsKey = `api:${id}:sessions`;
    const activeCount = Number(await redis.get(activeSessionsKey) || 0);
    const closedSessionsKey = `api:${id}:closedSessions`;
    const closedCount = Number(await redis.get(closedSessionsKey) || 0);
    monitoring.push({ id, apiKey: data.apiKey, characterId: data.characterId, maxSessions: data.maxSessions, ttl: data.ttl, activeCount, closedCount });
  }
  return monitoring; // Ensure it's an array
}

// Start server
const PORT = 3006;
app.listen(PORT, () => {
  console.log(`🚀 Load balancer running at http://localhost:${PORT}`);
});
