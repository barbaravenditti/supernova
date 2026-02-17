/**
 * RadioFlow - Intelligent radio flow algorithm
 * 
 * Features:
 * - Custom or default selection algorithm (1,2,3,4,5 or custom like 1,2,1,3,2,2,4)
 * - Reshuffles each playlist when exhausted
 * - Avoids playing same artist too close together
 * - No track repeats until all playlists are exhausted
 * - Dynamically generates flow instead of pre-creating a playlist
 */
class RadioFlow {
  constructor(playlistTracks, algorithm = null, jingleIndexes = []) {
    // playlistTracks is array of arrays of track objects
    this.playlists = playlistTracks.map(tracks => ({
      tracks: this.shuffle([...tracks]), // Shuffle initially
      index: 0,
      exhausted: false
    }));

    const numPlaylists = this.playlists.length;

    // Parse algorithm (e.g., "1,2,1,3,2,2,4" or default sequential based on actual playlist count)
    this.algorithm = algorithm 
      ? algorithm.split(',').map(n => parseInt(n.trim()) - 1) // Convert to 0-based index
      : Array.from({length: numPlaylists}, (_, i) => i); // Default: [0,1,2,...] based on actual count

    this.algorithmIndex = 0;
    this.jingleIndexes = new Set(jingleIndexes); // Set of playlist indexes that are jingles
    this.playedTracks = new Set(); // Track URIs already played in current cycle
    this.recentArtists = []; // Recent artist IDs to avoid repetition
    this.maxRecentArtists = 50; // Don't repeat artist within last 50 tracks
    this.allPlaylistsExhausted = false;
    this.cycleCount = 0;
  }

  /**
   * Fisher-Yates shuffle
   */
  shuffle(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  /**
   * Get next playlist according to algorithm
   */
  getNextPlaylistIndex() {
    const playlistIndex = this.algorithm[this.algorithmIndex];
    this.algorithmIndex = (this.algorithmIndex + 1) % this.algorithm.length;
    return playlistIndex;
  }

  /**
   * Check if artist was played recently
   */
  isArtistRecent(artistId) {
    return this.recentArtists.includes(artistId);
  }

  /**
   * Add artist to recent list
   */
  addRecentArtist(artistId) {
    this.recentArtists.push(artistId);
    if (this.recentArtists.length > this.maxRecentArtists) {
      this.recentArtists.shift();
    }
  }

  /**
   * Get next track from a specific playlist, avoiding recent artists
   */
  getTrackFromPlaylist(playlistIndex) {
    const playlist = this.playlists[playlistIndex];

    if (!playlist || playlist.exhausted) {
      return null;
    }

    // Try to find a track with an artist that wasn't played recently
    // Jingle playlists skip artist check entirely
    const isJingle = this.jingleIndexes.has(playlistIndex);
    const startIndex = playlist.index;
    let attempts = 0;
    const maxAttempts = playlist.tracks.length;

    while (attempts < maxAttempts) {
      const track = playlist.tracks[playlist.index];
      
      // Check if track was already played and artist not recent (jingles skip artist check)
      if (!this.playedTracks.has(track.uri) && (isJingle || !this.isArtistRecent(track.artistId))) {
        playlist.index++;
        
        // Mark as played (don't add jingle artist to recent list)
        this.playedTracks.add(track.uri);
        if (!isJingle) this.addRecentArtist(track.artistId);

        // Check if playlist is exhausted
        if (playlist.index >= playlist.tracks.length) {
          playlist.exhausted = true;
        }

        return track;
      }

      // Move to next track
      playlist.index = (playlist.index + 1) % playlist.tracks.length;
      attempts++;

      // If we've looped back, try with less strict artist checking
      if (playlist.index === startIndex) {
        break;
      }
    }

    // Fallback: just get any unplayed track
    for (let i = 0; i < playlist.tracks.length; i++) {
      const track = playlist.tracks[i];
      if (!this.playedTracks.has(track.uri)) {
        this.playedTracks.add(track.uri);
        if (!isJingle) this.addRecentArtist(track.artistId);
        playlist.index = i + 1;
        
        if (playlist.index >= playlist.tracks.length) {
          playlist.exhausted = true;
        }
        
        return track;
      }
    }

    // All tracks played from this playlist
    playlist.exhausted = true;
    return null;
  }

  /**
   * Check if all playlists are exhausted
   */
  checkAllExhausted() {
    return this.playlists.every(p => p.exhausted);
  }

  /**
   * Reset cycle - reshuffle all playlists and start over
   */
  resetCycle() {
    console.log(`🔄 Cycle ${this.cycleCount + 1} complete! Reshuffling all playlists...`);
    
    this.cycleCount++;
    this.playedTracks.clear();
    this.recentArtists = [];
    
    this.playlists.forEach(playlist => {
      playlist.tracks = this.shuffle(playlist.tracks);
      playlist.index = 0;
      playlist.exhausted = false;
    });

    this.allPlaylistsExhausted = false;
  }

  /**
   * Get the next N tracks for playback
   */
  getNextTracks(count = 10) {
    const tracks = [];
    let attempts = 0;
    const maxAttempts = count * 10; // Prevent infinite loops

    while (tracks.length < count && attempts < maxAttempts) {
      attempts++;

      // Check if we need to reset cycle
      if (this.checkAllExhausted()) {
        this.resetCycle();
      }

      // Get next playlist according to algorithm
      const playlistIndex = this.getNextPlaylistIndex();
      const track = this.getTrackFromPlaylist(playlistIndex);

      if (track) {
        tracks.push(track);
      }
    }

    return tracks;
  }

  /**
   * Get total tracks across all playlists
   */
  getTotalTracks() {
    return this.playlists.reduce((sum, p) => sum + p.tracks.length, 0);
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      cycleCount: this.cycleCount,
      totalTracksPlayed: this.playedTracks.size,
      totalTracks: this.getTotalTracks(),
      algorithm: this.algorithm.map(i => i + 1).join(','),
      playlistsStatus: this.playlists.map((p, i) => ({
        playlist: i + 1,
        tracksRemaining: p.tracks.length - p.index,
        exhausted: p.exhausted
      }))
    };
  }
}

module.exports = { RadioFlow };
