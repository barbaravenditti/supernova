const axios = require('axios');

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;

const SCOPES = [
  'user-read-private',
  'user-read-email',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-modify-playback-state',
  'user-read-playback-state',
  'user-read-currently-playing'
].join(' ');

function getAuthUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES
  });
  return 'https://accounts.spotify.com/authorize?' + params.toString();
}

async function handleCallback(code) {
  const authString = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: REDIRECT_URI
    }),
    {
      headers: {
        'Authorization': 'Basic ' + authString,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );
  return {
    access_token: response.data.access_token,
    refresh_token: response.data.refresh_token,
    expires_in: response.data.expires_in
  };
}

async function refreshAccessToken(refreshToken) {
  const authString = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    }),
    {
      headers: {
        'Authorization': 'Basic ' + authString,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );
  return response.data.access_token;
}

module.exports = {
  getAuthUrl,
  handleCallback,
  refreshAccessToken
};
