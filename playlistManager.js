const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'playlist-cache.json');
const CONFIG_FILE = path.join(CACHE_DIR, 'supernova-config.json');

// Configurazione Supernova predefinita
const SUPERNOVA_CONFIG = {
  name: "Radio Supernova",
  playlists: [
    "Radio Supernova ID", "Best 50", "Best 60", "Best 60 Italia",
    "Best Classic Soul", "Best 70", "Best 70 Italia", "Best 80",
    "Best Soul 80 e 90", "Best 90", "Best 80 e 90 Italia",
    "Best Rock 2000", "Best Indie 2000", "Best 2000 Italia",
    "Best Soul 2000", "Best Pop 2000"
  ],
  algorithm: "16,1,2,1,14,13,1,3,3,1,13,12,1,10,12,1,13,16,1,16,13,1,13,12,1,10,12,1,15,14,1,15,15,1,15,13,1,16,16,1,15,15,1,5,8,1,10,5,1,4,9,1,11,16,1,11,6,1,6,8,1,9,5,1,10,8,1,7,8,1,10,9,1,10,9"
};

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      console.log('💾 Cache trovata! Ultimo aggiornamento:', new Date(data.lastUpdated).toLocaleString('it-IT'));
      return data;
    }
  } catch (e) {
    console.log('⚠️ Cache corrotta, verrà rigenerata');
  }
  return null;
}

function saveCache(playlistData) {
  ensureCacheDir();
  const cacheData = {
    lastUpdated: new Date().toISOString(),
    playlists: playlistData
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2));
  console.log('💾 Cache salvata! (' + Object.keys(playlistData).length + ' playlist)');
}

function getCachedPlaylists(playlistNames) {
  const cache = loadCache();
  if (!cache) return null;

  const results = [];
  const missing = [];

  for (const name of playlistNames) {
    const key = name.toLowerCase().trim();
    const cachedKey = Object.keys(cache.playlists).find(k =>
      k.toLowerCase().includes(key) || key.includes(k.toLowerCase())
    );
    if (cachedKey && cache.playlists[cachedKey] && cache.playlists[cachedKey].length > 0) {
      results.push({ name: cachedKey, tracks: cache.playlists[cachedKey] });
    } else {
      missing.push(name);
    }
  }

  return { results, missing };
}

function updateCache(playlistName, tracks) {
  const cache = loadCache() || { lastUpdated: new Date().toISOString(), playlists: {} };
  cache.playlists[playlistName] = tracks;
  cache.lastUpdated = new Date().toISOString();
  ensureCacheDir();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function getCacheInfo() {
  const cache = loadCache();
  if (!cache) return null;
  const names = Object.keys(cache.playlists);
  const totalTracks = names.reduce((sum, k) => sum + cache.playlists[k].length, 0);
  return {
    lastUpdated: cache.lastUpdated,
    playlistCount: names.length,
    totalTracks,
    playlistNames: names
  };
}

function clearCache() {
  if (fs.existsSync(CACHE_FILE)) {
    fs.unlinkSync(CACHE_FILE);
    console.log('🗑️ Cache eliminata');
    return true;
  }
  return false;
}

// ---------- SPOTIFY API ----------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getUserPlaylists(accessToken) {
  let allPlaylists = [];
  let offset = 0;
  const limit = 50;
  let hasMore = true;

  while (hasMore) {
    const response = await axios.get('https://api.spotify.com/v1/me/playlists', {
      headers: { 'Authorization': 'Bearer ' + accessToken },
      params: { limit, offset }
    });
    allPlaylists = allPlaylists.concat(response.data.items);
    hasMore = response.data.next !== null;
    offset += limit;
  }

  return allPlaylists
    .filter(p => p && p.id && p.name)
    .map(p => ({ id: p.id, name: p.name }));
}

async function getPlaylistTracks(accessToken, playlistId) {
  console.log('🔍 Carico tracce playlist:', playlistId);
  let allTracks = [];
  let offset = 0;
  const limit = 100;
  let hasMore = true;

  try {
    while (hasMore) {
      const response = await axios.get(
        'https://api.spotify.com/v1/playlists/' + playlistId + '/items',
        { headers: { 'Authorization': 'Bearer ' + accessToken }, params: { limit, offset } }
      );

      const tracks = response.data.items
        .filter(item => {
          const track = item.track || item.item;
          return track && track.id;
        })
        .map(item => {
          const track = item.track || item.item;
          return {
            uri: track.uri,
            id: track.id,
            name: track.name,
            artist: track.artists[0].name,
            artistId: track.artists[0].id
          };
        });

      allTracks = allTracks.concat(tracks);
      hasMore = response.data.next !== null;
      offset += limit;

      if (hasMore) await sleep(400);
    }
  } catch (error) {
    console.error('❌ Errore:', error.response?.status, error.response?.statusText);
    throw new Error('Errore caricamento (codice ' + (error.response?.status || '?') + ')');
  }

  if (allTracks.length === 0) throw new Error('Playlist vuota');
  console.log('📊 Totale:', allTracks.length, 'tracce');
  return allTracks;
}

// ---------- SUPERNOVA CONFIG ----------

function getSupernovaConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return SUPERNOVA_CONFIG;
}

function saveSupernovaConfig(config) {
  ensureCacheDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

module.exports = {
  getUserPlaylists,
  getPlaylistTracks,
  loadCache, saveCache,
  getCachedPlaylists, updateCache,
  getCacheInfo, clearCache,
  getSupernovaConfig, saveSupernovaConfig,
  sleep
};
