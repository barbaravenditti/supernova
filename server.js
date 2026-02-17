require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { getAuthUrl, handleCallback, refreshAccessToken } = require('./spotifyAuth');
const {
  getUserPlaylists, getPlaylistTracks,
  getCachedPlaylists, updateCache, getCacheInfo, clearCache,
  getSupernovaConfig, saveSupernovaConfig, sleep
} = require('./playlistManager');
const { RadioFlow } = require('./radioFlow');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

const activeRadios = new Map();
const loadedPlaylists = new Map();
const radioLoops = new Map();

// ---------- HELPER: Spotify API con retry ----------

async function spotifyRequest(fn, accessToken, refreshToken, res) {
  try {
    return await fn(accessToken);
  } catch (error) {
    if (error.response?.status === 401 && refreshToken) {
      try {
        const newToken = await refreshAccessToken(refreshToken);
        if (res) {
          res.cookie('access_token', newToken, { maxAge: 3600000 });
        }
        return await fn(newToken);
      } catch (e) {
        throw error;
      }
    }
    throw error;
  }
}

async function getCurrentPlayback(accessToken) {
  try {
    const response = await axios.get('https://api.spotify.com/v1/me/player', {
      headers: { 'Authorization': 'Bearer ' + accessToken }
    });
    return response.data;
  } catch (error) { return null; }
}

async function getQueue(accessToken) {
  try {
    const response = await axios.get('https://api.spotify.com/v1/me/player/queue', {
      headers: { 'Authorization': 'Bearer ' + accessToken }
    });
    return response.data;
  } catch (error) { return null; }
}

async function addToQueue(accessToken, trackUri) {
  try {
    await axios.post('https://api.spotify.com/v1/me/player/queue?uri=' + encodeURIComponent(trackUri), {}, {
      headers: { 'Authorization': 'Bearer ' + accessToken }
    });
    return true;
  } catch (error) {
    if (error.response?.status === 429) {
      const retryAfter = parseInt(error.response.headers['retry-after'] || '5');
      console.log('⏳ Rate limit! Aspetto', retryAfter, 'secondi...');
      await sleep(retryAfter * 1000);
      // Riprova una volta
      try {
        await axios.post('https://api.spotify.com/v1/me/player/queue?uri=' + encodeURIComponent(trackUri), {}, {
          headers: { 'Authorization': 'Bearer ' + accessToken }
        });
        return true;
      } catch (e) { return false; }
    }
    console.error('Errore aggiunta a coda:', error.response?.status);
    return false;
  }
}

// ---------- RADIO LOOP ----------

async function radioLoop(userId, accessToken) {
  console.log('🔄 Loop radio attivo per user:', userId);

  let consecutiveErrors = 0;

  while (radioLoops.has(userId)) {
    try {
      const radioFlow = activeRadios.get(userId);
      if (!radioFlow) break;

      // Controlla lo stato del player
      const playback = await getCurrentPlayback(accessToken);
      const queue = await getQueue(accessToken);
      const queueLength = queue?.queue?.length || 0;
      const isPlaying = playback?.is_playing || false;
      const hasTrack = playback?.item != null;

      console.log('📊 Coda:', queueLength, '| In riproduzione:', isPlaying ? 'sì' : 'no');

      // Se il player si è fermato ma la radio è ancora attiva, riavvia
      if (!isPlaying && hasTrack && queueLength === 0) {
        console.log('⚠️ Player fermo! Riavvio...');
        const newTracks = radioFlow.getNextTracks(20);
        const trackUris = newTracks.map(t => t.uri);
        try {
          await axios.put('https://api.spotify.com/v1/me/player/play', { uris: trackUris }, {
            headers: { 'Authorization': 'Bearer ' + accessToken }
          });
          console.log('✅ Player riavviato con', newTracks.length, 'tracce');
        } catch (e) {
          console.log('❌ Riavvio fallito:', e.response?.status);
        }
      }
      // Se la coda è sotto 15 tracce, riempi
      else if (queueLength < 15) {
        const toAdd = 20 - queueLength;
        const newTracks = radioFlow.getNextTracks(toAdd);
        console.log('➕ Aggiungo', newTracks.length, 'tracce alla coda');

        for (let track of newTracks) {
          const ok = await addToQueue(accessToken, track.uri);
          if (!ok) {
            await sleep(3000);
          }
          await sleep(100);
        }
      }

      consecutiveErrors = 0;

      // Controlla ogni 15 secondi — una radio vera non si ferma
      await sleep(15000);
    } catch (error) {
      consecutiveErrors++;
      console.error('Errore nel loop (' + consecutiveErrors + '):', error.message);
      
      // Se troppi errori consecutivi, rallenta
      if (consecutiveErrors > 10) {
        console.log('⚠️ Troppi errori, rallento a 60 secondi');
        await sleep(60000);
      } else {
        await sleep(15000);
      }
    }
  }

  console.log('🛑 Loop radio fermato per user:', userId);
}

// ---------- ROUTES ----------

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.get('/login', (req, res) => {
  res.redirect(getAuthUrl());
});

app.get('/callback', async (req, res) => {
  const code = req.query.code || null;
  if (!code) return res.redirect('/#error=no_code');
  try {
    const tokens = await handleCallback(code);
    res.cookie('access_token', tokens.access_token, { maxAge: 3600000 });
    res.cookie('refresh_token', tokens.refresh_token, { maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.redirect('/#success');
  } catch (error) {
    console.error('Callback error:', error);
    res.redirect('/#error=auth_failed');
  }
});

app.get('/api/me', async (req, res) => {
  const accessToken = req.cookies.access_token;
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const response = await axios.get('https://api.spotify.com/v1/me', {
      headers: { 'Authorization': 'Bearer ' + accessToken }
    });
    res.json(response.data);
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ---------- CACHE INFO ----------

app.get('/api/cache-info', (req, res) => {
  const info = getCacheInfo();
  res.json(info || { empty: true });
});

app.delete('/api/cache', (req, res) => {
  clearCache();
  res.json({ success: true, message: 'Cache eliminata' });
});

// ---------- SUPERNOVA CONFIG ----------

app.get('/api/supernova-config', (req, res) => {
  res.json(getSupernovaConfig());
});

app.post('/api/supernova-config', (req, res) => {
  const { playlists, algorithm, name } = req.body;
  saveSupernovaConfig({ name: name || 'Radio Supernova', playlists, algorithm });
  res.json({ success: true });
});

// ---------- FIND AND LOAD (cache-first) ----------

app.post('/api/find-and-load', async (req, res) => {
  const { playlistNames, forceRefresh } = req.body;
  const accessToken = req.cookies.access_token;
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated' });
  if (!playlistNames || playlistNames.length < 2 || playlistNames.length > 20) {
    return res.status(400).json({ error: 'Serve da 2 a 20 playlist' });
  }

  try {
    const playlistTracks = [];
    const skippedPlaylists = [];
    const loadedNames = [];
    let fromCache = 0;
    let fromApi = 0;

    // 1) Controlla la cache (se non forzato refresh)
    let cached = null;
    if (!forceRefresh) {
      cached = getCachedPlaylists(playlistNames);
    }

    // 2) Separa: cosa c'è in cache vs cosa scaricare
    const needsDownload = forceRefresh ? [...playlistNames] : (cached ? cached.missing : [...playlistNames]);
    const cachedResults = (!forceRefresh && cached) ? cached.results : [];

    // Aggiungi le playlist dalla cache
    for (const item of cachedResults) {
      playlistTracks.push(item.tracks);
      loadedNames.push(item.name);
      fromCache++;
      console.log('💾 Da cache:', item.name, '(' + item.tracks.length + ' tracce)');
    }

    // 3) Scarica solo quelle mancanti
    if (needsDownload.length > 0) {
      console.log('🌐 Scarico', needsDownload.length, 'playlist da Spotify...');
      const userPlaylists = await getUserPlaylists(accessToken);

      for (const searchName of needsDownload) {
        const found = userPlaylists.find(p =>
          p.name.toLowerCase().includes(searchName.toLowerCase())
        );

        if (!found) {
          console.log('❌ Non trovata:', searchName);
          skippedPlaylists.push(searchName);
          continue;
        }

        console.log('✅ Trovata:', found.name);

        try {
          await sleep(600); // Pausa generosa tra playlist
          const tracks = await getPlaylistTracks(accessToken, found.id);
          playlistTracks.push(tracks);
          loadedNames.push(found.name);
          fromApi++;

          // Salva in cache
          updateCache(found.name, tracks);
          console.log('💾 Salvata in cache:', found.name);
        } catch (error) {
          if (error.message.includes('429') || error.message.includes('rate')) {
            console.log('⏳ Rate limit! Aspetto 30 secondi...');
            await sleep(30000);
            // Riprova
            try {
              const tracks = await getPlaylistTracks(accessToken, found.id);
              playlistTracks.push(tracks);
              loadedNames.push(found.name);
              fromApi++;
              updateCache(found.name, tracks);
            } catch (e) {
              skippedPlaylists.push(searchName);
            }
          } else {
            skippedPlaylists.push(searchName);
          }
        }
      }
    }

    if (playlistTracks.length < 2) {
      return res.status(400).json({
        error: 'Meno di 2 playlist valide. Trovate: ' + playlistTracks.length
      });
    }

    const userId = req.cookies.user_id || Date.now().toString();
    res.cookie('user_id', userId, { maxAge: 24 * 60 * 60 * 1000 });
    loadedPlaylists.set(userId, playlistTracks);
    const totalTracks = playlistTracks.reduce((sum, p) => sum + p.length, 0);

    let message = playlistTracks.length + ' playlist caricate con ' + totalTracks + ' tracce!';
    if (fromCache > 0) message += ' (' + fromCache + ' da cache, ' + fromApi + ' da Spotify)';
    if (skippedPlaylists.length > 0) message += ' | ' + skippedPlaylists.length + ' saltate';

    console.log('✅ ' + message);
    res.json({ playlistCount: playlistTracks.length, totalTracks, fromCache, fromApi, message, loadedNames: loadedNames });
  } catch (error) {
    console.error('Find and load error:', error);
    res.status(500).json({ error: error.message || 'Errore' });
  }
});

// ---------- START / STOP RADIO ----------

app.post('/api/start-radio', async (req, res) => {
  const { algorithm, jingleIndexes } = req.body;
  const userId = req.cookies.user_id;
  const accessToken = req.cookies.access_token;

  if (!userId || !loadedPlaylists.has(userId)) {
    return res.status(404).json({ error: 'No playlists loaded' });
  }

  try {
    const playlistTracks = loadedPlaylists.get(userId);
    const radioFlow = new RadioFlow(playlistTracks, algorithm, jingleIndexes || []);
    activeRadios.set(userId, radioFlow);

    const initialTracks = radioFlow.getNextTracks(20);
    const trackUris = initialTracks.map(t => t.uri);

    await axios.put('https://api.spotify.com/v1/me/player/play', { uris: trackUris }, {
      headers: { 'Authorization': 'Bearer ' + accessToken }
    });

    radioLoops.set(userId, true);
    radioLoop(userId, accessToken);

    res.json({ success: true, totalTracks: radioFlow.getTotalTracks(), message: 'Radio infinita attivata!' });
  } catch (error) {
    console.error('Start radio error:', error);
    res.status(500).json({ error: 'Failed to start radio. Assicurati che Spotify sia aperto!' });
  }
});

app.post('/api/stop-radio', (req, res) => {
  const userId = req.cookies.user_id;
  if (userId && radioLoops.has(userId)) {
    radioLoops.delete(userId);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'No active radio' });
  }
});

app.get('/api/radio-status', async (req, res) => {
  const userId = req.cookies.user_id;
  const accessToken = req.cookies.access_token;

  if (!userId || !radioLoops.has(userId)) {
    return res.json({ active: false });
  }

  try {
    const playback = await getCurrentPlayback(accessToken);
    const queue = await getQueue(accessToken);
    res.json({
      active: true,
      currentTrack: playback?.item?.name || 'N/A',
      currentArtist: playback?.item?.artists?.[0]?.name || '',
      queueLength: queue?.queue?.length || 0
    });
  } catch (error) {
    res.json({ active: true, error: 'Cannot get status' });
  }
});

// ---------- START SERVER ----------

app.listen(PORT, () => {
  const cacheInfo = getCacheInfo();
  console.log('');
  console.log('🎵 Radio Supernova Server');
  console.log('   http://127.0.0.1:' + PORT);
  console.log('');
  if (cacheInfo) {
    console.log('💾 Cache: ' + cacheInfo.playlistCount + ' playlist, ' + cacheInfo.totalTracks + ' tracce');
    console.log('   Ultimo aggiornamento: ' + new Date(cacheInfo.lastUpdated).toLocaleString('it-IT'));
  } else {
    console.log('💾 Cache: vuota (prima volta = scaricherà da Spotify)');
  }
  console.log('');
});
