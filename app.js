/**
 * NOVASTREAM IPTV — Client Engine
 * TiviMate & OTT Navigator Style Playback, HLS.js, EPG Engine, Audio Boost & Zapping
 */

(function () {
  'use strict';

  // Application State
  let allChannels = [];
  let displayedChannels = [];
  let activeCategory = 'ALL';
  let searchQuery = '';
  let currentSort = 'default';
  
  let currentChannel = null;
  let currentChannelIndex = -1;
  let hls = null;
  let osdTimer = null;
  let streamRetryCount = 0;
  
  // Aspect Ratios: 'aspect-16-9' | 'aspect-4-3' | 'aspect-fill' | 'aspect-stretch'
  const aspectRatios = ['aspect-16-9', 'aspect-4-3', 'aspect-fill', 'aspect-stretch'];
  const aspectLabels = { 'aspect-16-9': '16:9', 'aspect-4-3': '4:3', 'aspect-fill': 'Fill', 'aspect-stretch': 'Stretch' };
  let currentAspectIdx = 0;

  // Web Audio Context for +200% Volume Boost
  let audioCtx = null;
  let audioSource = null;
  let gainNode = null;
  let isAudioBoosted = false;

  // LocalStorage Keys
  const STORAGE_FAVS = 'novastream_favs_v1';
  const STORAGE_RECENT = 'novastream_recent_v1';
  const STORAGE_LAST_CHANNEL = 'novastream_last_ch_v1';

  let favorites = new Set(JSON.parse(localStorage.getItem(STORAGE_FAVS) || '[]'));
  let recentChannels = JSON.parse(localStorage.getItem(STORAGE_RECENT) || '[]');

  // DOM Elements
  const el = {};

  function initApp() {
    cacheElements();
    setupEventListeners();
    fetchPlaylist();
  }

  function cacheElements() {
    el.videoPlayer = document.getElementById('videoPlayer');
    el.videoWrapper = document.getElementById('videoWrapper');
    el.videoSpinner = document.getElementById('videoSpinner');
    el.spinnerText = document.getElementById('spinnerText');
    
    el.controlsBar = document.getElementById('controlsBar');
    el.btnPlayPause = document.getElementById('btnPlayPause');
    el.playIcon = document.getElementById('playIcon');
    el.pauseIcon = document.getElementById('pauseIcon');
    el.volumeSlider = document.getElementById('volumeSlider');
    el.volHighIcon = document.getElementById('volHighIcon');
    el.volMuteIcon = document.getElementById('volMuteIcon');
    el.audioBoostBtn = document.getElementById('audioBoostBtn');
    el.aspectRatioBtn = document.getElementById('aspectRatioBtn');
    el.playingTitleBar = document.getElementById('playingTitleBar');
    
    el.osdOverlay = document.getElementById('osdOverlay');
    el.osdLogo = document.getElementById('osdLogo');
    el.osdNumber = document.getElementById('osdNumber');
    el.osdName = document.getElementById('osdName');
    el.osdCategory = document.getElementById('osdCategory');
    el.osdProgram = document.getElementById('osdProgram');
    el.osdProgressFill = document.getElementById('osdProgressFill');
    el.osdTime = document.getElementById('osdTime');
    el.streamQualityBadge = document.getElementById('streamQualityBadge');
    
    el.categoryTabs = document.getElementById('categoryTabs');
    el.channelList = document.getElementById('channelList');
    el.channelSearch = document.getElementById('channelSearch');
    el.searchClearBtn = document.getElementById('searchClearBtn');
    el.guideCount = document.getElementById('guideCount');
    
    el.settingsModal = document.getElementById('settingsModal');
    el.shortcutsModal = document.getElementById('shortcutsModal');
    el.epgModal = document.getElementById('epgModal');
    el.epgTimelineGrid = document.getElementById('epgTimelineGrid');
  }

  function setupEventListeners() {
    // Search input
    el.channelSearch.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim().toLowerCase();
      el.searchClearBtn.style.display = searchQuery ? 'block' : 'none';
      filterAndRenderChannels();
    });

    // Keyboard Shortcuts
    document.addEventListener('keydown', handleGlobalKeydown);

    // Mouse movement inside video resets OSD & controls visibility
    el.videoWrapper.addEventListener('mousemove', triggerOsdBriefly);
    el.videoWrapper.addEventListener('click', triggerOsdBriefly);

    // Video Player events
    el.videoPlayer.addEventListener('playing', () => {
      streamRetryCount = 0;
      el.videoSpinner.style.display = 'none';
      el.playIcon.style.display = 'none';
      el.pauseIcon.style.display = 'block';
    });

    el.videoPlayer.addEventListener('pause', () => {
      el.playIcon.style.display = 'block';
      el.pauseIcon.style.display = 'none';
    });

    el.videoPlayer.addEventListener('waiting', () => {
      el.videoSpinner.style.display = 'flex';
      el.spinnerText.textContent = 'Buffering stream...';
    });

    el.videoPlayer.addEventListener('error', () => {
      el.videoSpinner.style.display = 'flex';
      el.spinnerText.innerHTML = '<span style="color:#ff3366;">⚠️ Stream Offline / Retrying...</span>';
    });
  }

  // 1. FETCH PLAYLIST FROM SERVER PROXY (WITH GITHUB PAGES STATIC FALLBACK)
  function fetchPlaylist(forceUrl) {
    el.guideCount.textContent = 'Connecting to proxy server...';
    const apiEndpoint = forceUrl ? `/api/refresh?url=${encodeURIComponent(forceUrl)}` : '/api/playlist';

    fetch(apiEndpoint)
      .then(res => {
        if (!res.ok) throw new Error('Backend proxy not found');
        return res.json();
      })
      .then(data => handleLoadedPlaylist(data))
      .catch(err => {
        // Fallback for static hosting like GitHub Pages
        console.warn('Backend proxy not reachable, loading static playlist_cache.json...');
        el.guideCount.textContent = 'Loading static channel cache...';
        fetch('playlist_cache.json')
          .then(res => {
            if (!res.ok) throw new Error('Static cache missing');
            return res.json();
          })
          .then(data => handleLoadedPlaylist(data))
          .catch(cacheErr => {
            console.error('Failed to load playlist:', cacheErr);
            el.guideCount.textContent = 'Connecting... retrying in 3s';
            setTimeout(() => fetchPlaylist(forceUrl), 3000);
          });
      });
  }

  function handleLoadedPlaylist(data) {
    allChannels = data.channels || [];
    el.guideCount.textContent = `${allChannels.length.toLocaleString()} Channels Loaded`;
    
    // Auto-generate dynamic category pills from playlist categories
    buildCategoryPills(data.categories || []);
    filterAndRenderChannels();
    resumeLastChannel();
  }

  function buildCategoryPills(cats) {
    // Keep standard top categories
    const standardPills = [
      { id: 'ALL', label: '🌟 All' },
      { id: 'FAV', label: '⭐ Favorites' },
      { id: 'RECENT', label: '🕒 Recent' },
      { id: 'INDIA', label: '🇮🇳 India' },
      { id: 'SPORTS', label: '🏏 Sports' },
      { id: '4K UHD', label: '📺 4K UHD' },
      { id: 'MOVIES', label: '🎬 Movies' },
      { id: 'NEWS', label: '📰 News' },
    ];

    let html = '';
    standardPills.forEach(p => {
      const activeCls = p.id === activeCategory ? 'active' : '';
      html += `<button class="cat-pill ${activeCls}" onclick="filterCategory('${p.id}')">${p.label}</button>`;
    });

    // Add remaining playlist groups
    cats.slice(0, 20).forEach(c => {
      if (!['ALL', 'FAV', 'RECENT', 'INDIA', 'SPORTS'].includes(c.toUpperCase())) {
        const shortName = c.replace(/^[|#].*?[|#]\s*/, '').trim();
        html += `<button class="cat-pill" onclick="filterCategory('${c}')">${shortName || c}</button>`;
      }
    });

    el.categoryTabs.innerHTML = html;
  }

  // 2. FILTER & RENDER CHANNELS
  window.filterCategory = function (cat) {
    activeCategory = cat;
    document.querySelectorAll('.cat-pill').forEach(b => {
      b.classList.remove('active');
      if (b.getAttribute('onclick').includes(`'${cat}'`)) {
        b.classList.add('active');
      }
    });
    filterAndRenderChannels();
  };

  function filterAndRenderChannels() {
    let pool = allChannels;

    // Category filter
    if (activeCategory === 'FAV') {
      pool = allChannels.filter(c => favorites.has(c.id));
    } else if (activeCategory === 'RECENT') {
      pool = recentChannels;
    } else if (activeCategory === 'INDIA') {
      pool = allChannels.filter(c => c.group.toUpperCase().includes('INDIA') || c.name.toUpperCase().includes('HINDI') || c.group.toUpperCase().includes('HINDI'));
    } else if (activeCategory === 'SPORTS') {
      pool = allChannels.filter(c => c.group.toUpperCase().includes('SPORT') || c.name.toUpperCase().includes('SPORT') || c.group.toUpperCase().includes('CRICKET'));
    } else if (activeCategory === '4K UHD') {
      pool = allChannels.filter(c => c.group.toUpperCase().includes('4K') || c.name.toUpperCase().includes('4K') || c.name.toUpperCase().includes('UHD'));
    } else if (activeCategory === 'MOVIES') {
      pool = allChannels.filter(c => c.group.toUpperCase().includes('MOVIE') || c.group.toUpperCase().includes('CINEMA') || c.name.toUpperCase().includes('CINEMA'));
    } else if (activeCategory === 'NEWS') {
      pool = allChannels.filter(c => c.group.toUpperCase().includes('NEWS') || c.name.toUpperCase().includes('NEWS'));
    } else if (activeCategory !== 'ALL') {
      pool = allChannels.filter(c => c.group.toLowerCase() === activeCategory.toLowerCase());
    }

    // Search filter
    if (searchQuery) {
      pool = pool.filter(c => c.name.toLowerCase().includes(searchQuery) || c.group.toLowerCase().includes(searchQuery));
    }

    // Sort
    if (currentSort === 'name') {
      pool = [...pool].sort((a, b) => a.name.localeCompare(b.name));
    } else if (currentSort === 'group') {
      pool = [...pool].sort((a, b) => a.group.localeCompare(b.group));
    }

    displayedChannels = pool;
    el.guideCount.textContent = `${displayedChannels.length.toLocaleString()} Channels`;

    renderChannelCardsBatch(displayedChannels.slice(0, 150));
  }

  function renderChannelCardsBatch(channels) {
    if (channels.length === 0) {
      el.channelList.innerHTML = `
        <div style="text-align:center;padding:40px 10px;color:var(--text-muted);">
          <div style="font-size:32px;margin-bottom:8px;">📡</div>
          <div style="font-size:14px;font-weight:600;">No Channels Found</div>
          <div style="font-size:12px;margin-top:4px;">Try a different search term or category</div>
        </div>`;
      return;
    }

    let html = '';
    channels.forEach((c, idx) => {
      const isPlaying = currentChannel && currentChannel.id === c.id;
      const isFav = favorites.has(c.id);
      const epg = generateDynamicEpg(c);

      const activeClass = isPlaying ? 'active-playing' : '';
      const favClass = isFav ? 'is-fav' : '';
      const logoSrc = c.logo || '';

      html += `
        <div class="channel-card ${activeClass}" id="chCard_${c.id}" onclick="playChannelById(${c.id})" style="display:flex;align-items:center;min-height:68px;height:68px;padding:8px 12px;box-sizing:border-box;gap:12px;flex-shrink:0;">
          <span class="card-num-badge" style="width:26px;font-family:'Outfit',sans-serif;font-weight:700;font-size:11px;color:var(--text-muted);text-align:center;flex-shrink:0;">${idx + 1}</span>
          
          <div class="card-logo-box" style="width:42px;height:42px;border-radius:var(--radius-sm);background:rgba(255,255,255,0.05);border:1px solid var(--border-glass);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;">
            ${logoSrc ? `<img class="card-logo-img" src="${logoSrc}" alt="" loading="lazy" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';" style="max-width:85%;max-height:85%;object-fit:contain;">` : ''}
            <span style="font-size:16px;display:${logoSrc ? 'none' : 'flex'};align-items:center;justify-content:center;width:100%;height:100%;">📺</span>
          </div>

          <div class="card-details" style="flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:3px;overflow:hidden;">
            <div class="card-name-row" style="display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:18px;">
              <span class="card-channel-name" title="${c.name}" style="font-size:13.5px;font-weight:700;color:#ffffff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;">${c.name}</span>
              ${isPlaying ? `
                <div class="playing-equalizer">
                  <span class="eq-bar"></span>
                  <span class="eq-bar"></span>
                  <span class="eq-bar"></span>
                </div>` : ''}
            </div>
            <span class="card-group-name" style="font-size:11px;color:var(--accent-cyan);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;">${c.group}</span>
            <div class="card-epg-row" style="display:flex;align-items:center;gap:6px;min-height:14px;">
              <span class="card-epg-title" style="font-size:11px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;">● ${epg.currentShow}</span>
              <div class="card-epg-bar" style="width:40px;height:3px;background:rgba(255,255,255,0.12);border-radius:2px;overflow:hidden;flex-shrink:0;">
                <div class="card-epg-fill" style="width:${epg.progress}%;height:100%;background:var(--accent-cyan);border-radius:2px;"></div>
              </div>
            </div>
          </div>

          <button class="fav-btn ${favClass}" onclick="toggleFavorite(${c.id}, event)" title="Add to Favorites" style="background:none;border:none;color:rgba(255,255,255,0.3);font-size:16px;cursor:pointer;flex-shrink:0;">
            ★
          </button>
        </div>`;
    });

    el.channelList.innerHTML = html;
  }

  // 3. PLAY CHANNEL VIA PROXY WITH HLS.JS
  window.playChannelById = function (chId) {
    const ch = allChannels.find(c => c.id === chId);
    if (ch) {
      playChannel(ch);
    }
  };

  function playChannel(ch) {
    currentChannel = ch;
    currentChannelIndex = displayedChannels.findIndex(c => c.id === ch.id);

    // Save as last watched
    localStorage.setItem(STORAGE_LAST_CHANNEL, JSON.stringify(ch));

    // Add to recent
    recentChannels = [ch, ...recentChannels.filter(c => c.id !== ch.id)].slice(0, 50);
    localStorage.setItem(STORAGE_RECENT, JSON.stringify(recentChannels));

    // Highlight card
    document.querySelectorAll('.channel-card').forEach(c => c.classList.remove('active-playing'));
    const activeCard = document.getElementById(`chCard_${ch.id}`);
    if (activeCard) {
      activeCard.classList.add('active-playing');
      activeCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // Proxy stream URL (supports local server, cloud proxy, or static fallback)
    const savedBackend = (localStorage.getItem('novastream_backend_url') || '').trim().replace(/\/+$/, '');
    let proxyUrl = '';
    if (savedBackend) {
      proxyUrl = `${savedBackend}/proxy/stream?url=${encodeURIComponent(ch.url)}`;
    } else {
      const isLocalOrHosted = (window.location.port === '5000' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || !window.location.hostname.includes('github.io'));
      proxyUrl = isLocalOrHosted ? `/proxy/stream?url=${encodeURIComponent(ch.url)}` : ch.url;
    }
    
    el.videoSpinner.style.display = 'flex';
    el.spinnerText.textContent = `Connecting to ${ch.name}...`;
    el.playingTitleBar.textContent = `${ch.name} • ${ch.group}`;

    // Update OSD
    const epg = generateDynamicEpg(ch);
    el.osdLogo.src = ch.logo || '';
    el.osdName.textContent = ch.name;
    el.osdNumber.textContent = `#${ch.id}`;
    el.osdCategory.textContent = ch.group;
    el.osdProgram.textContent = `${epg.currentShow} (Next: ${epg.nextShow})`;
    el.osdProgressFill.style.width = `${epg.progress}%`;
    el.osdTime.textContent = `${epg.startStr} - ${epg.endStr} (${epg.remainingMin}m left)`;
    
    triggerOsdBriefly();

    // Setup HLS Stream
    if (hls) {
      hls.destroy();
      hls = null;
    }

    if (Hls.isSupported()) {
      hls = new Hls({
        debug: false,
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 60,
        maxBufferSize: 30 * 1000 * 1000,
        maxBufferLength: 20
      });

      hls.loadSource(proxyUrl);
      hls.attachMedia(el.videoPlayer);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        el.videoPlayer.play().catch(() => {});
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
        const level = hls.levels[data.level];
        if (level && level.height) {
          el.streamQualityBadge.textContent = `${level.height}p • LIVE`;
        }
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              streamRetryCount++;
              if (streamRetryCount <= 3) {
                el.videoSpinner.style.display = 'flex';
                el.spinnerText.innerHTML = `<span style="color:#00d2ff;">Reconnecting stream (${streamRetryCount}/3)...</span>`;
                setTimeout(() => { if (hls) hls.startLoad(); }, 1500);
              } else {
                el.videoSpinner.style.display = 'flex';
                const isGithub = window.location.hostname.includes('github.io');
                const hasBackend = !!(localStorage.getItem('novastream_backend_url') || '').trim();
                if (isGithub && !hasBackend) {
                  el.spinnerText.innerHTML = `
                    <div style="display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;padding:16px;">
                      <span style="color:#ffb703;font-weight:700;font-size:15px;">⚠️ Browser Security Notice (GitHub Pages)</span>
                      <span style="font-size:12px;color:rgba(255,255,255,0.85);max-width:320px;line-height:1.4;">
                        GitHub Pages par browser direct video streams block karta hai (CORS &amp; Mixed Content).
                      </span>
                      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:6px;">
                        <button class="osd-btn-accent" style="padding:7px 14px;border-radius:18px;cursor:pointer;background:linear-gradient(135deg, #00d2ff, #7928ca);color:#fff;border:none;font-size:12px;font-weight:700;" onclick="openSettingsModal()">⚙️ Connect Backend</button>
                        <button class="osd-btn-accent" style="padding:7px 14px;border-radius:18px;cursor:pointer;background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.3);font-size:12px;font-weight:600;" onclick="copyPlaylistUrl()">📋 Copy M3U for VLC</button>
                      </div>
                    </div>`;
                } else {
                  el.spinnerText.innerHTML = `
                    <div style="display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;padding:12px;">
                      <span style="color:#ff4757;font-weight:700;font-size:15px;">⚠️ Stream Offline or Busy</span>
                      <span style="font-size:12px;color:rgba(255,255,255,0.7);max-width:280px;">Upstream provider rate-limited or channel feed offline.</span>
                      <button class="osd-btn-accent" style="margin-top:6px;padding:8px 18px;border-radius:20px;cursor:pointer;background:linear-gradient(135deg, #00d2ff, #7928ca);color:#fff;border:none;font-weight:700;" onclick="zapChannel(1)">Next Channel ▶</button>
                    </div>`;
                }
              }
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.warn('Media error, attempting stream recovery...');
              hls.recoverMediaError();
              break;
            default:
              console.error('Fatal stream error:', data);
              el.videoSpinner.style.display = 'flex';
              el.spinnerText.innerHTML = `
                <div style="display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;padding:12px;">
                  <span style="color:#ff4757;font-weight:700;">⚠️ Playback Interrupted</span>
                  <button class="osd-btn-accent" style="margin-top:6px;padding:8px 18px;border-radius:20px;cursor:pointer;background:linear-gradient(135deg, #00d2ff, #7928ca);color:#fff;border:none;font-weight:700;" onclick="zapChannel(1)">Next Channel ▶</button>
                </div>`;
              if (hls) hls.destroy();
              break;
          }
        }
      });

    } else if (el.videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
      // Native Safari / iOS support
      el.videoPlayer.src = proxyUrl;
      el.videoPlayer.play().catch(() => {});
    }
  }

  // 4. CHANNEL ZAPPING (PREV / NEXT)
  window.zapChannel = function (delta) {
    if (displayedChannels.length === 0) return;
    
    if (currentChannelIndex === -1) {
      currentChannelIndex = 0;
    } else {
      currentChannelIndex = (currentChannelIndex + delta + displayedChannels.length) % displayedChannels.length;
    }

    const nextCh = displayedChannels[currentChannelIndex];
    if (nextCh) {
      playChannel(nextCh);
    }
  };

  // 5. OSD FADE IN/OUT
  function triggerOsdBriefly() {
    el.osdOverlay.classList.add('visible');
    el.controlsBar.classList.add('always-show');

    if (osdTimer) clearTimeout(osdTimer);
    osdTimer = setTimeout(() => {
      el.osdOverlay.classList.remove('visible');
      el.controlsBar.classList.remove('always-show');
    }, 4500);
  }

  // 6. CONTROLS: PLAY, MUTE, VOLUME, AUDIO BOOST
  window.togglePlay = function () {
    if (el.videoPlayer.paused) {
      el.videoPlayer.play();
    } else {
      el.videoPlayer.pause();
    }
  };

  window.setVolume = function (val) {
    el.videoPlayer.volume = val;
    el.videoPlayer.muted = (val === '0');
    el.volMuteIcon.style.display = (val === '0') ? 'block' : 'none';
    el.volHighIcon.style.display = (val === '0') ? 'none' : 'block';
  };

  window.toggleMute = function () {
    el.videoPlayer.muted = !el.videoPlayer.muted;
    if (el.videoPlayer.muted) {
      el.volMuteIcon.style.display = 'block';
      el.volHighIcon.style.display = 'none';
      el.volumeSlider.value = 0;
    } else {
      el.volMuteIcon.style.display = 'none';
      el.volHighIcon.style.display = 'block';
      el.volumeSlider.value = el.videoPlayer.volume || 1;
    }
  };

  // Web Audio API 200% Boost
  window.toggleAudioBoost = function () {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        audioSource = audioCtx.createMediaElementSource(el.videoPlayer);
        gainNode = audioCtx.createGain();
        audioSource.connect(gainNode);
        gainNode.connect(audioCtx.destination);
      }

      isAudioBoosted = !isAudioBoosted;
      if (isAudioBoosted) {
        gainNode.gain.value = 2.2; // 220% audio gain
        el.audioBoostBtn.classList.add('active');
        el.audioBoostBtn.textContent = 'BOOSTED';
      } else {
        gainNode.gain.value = 1.0;
        el.audioBoostBtn.classList.remove('active');
        el.audioBoostBtn.textContent = '+200%';
      }
    } catch (e) {
      console.warn('Audio boost not available for current audio route:', e);
    }
  };

  // 7. ASPECT RATIO CYCLER
  window.cycleAspectRatio = function () {
    currentAspectIdx = (currentAspectIdx + 1) % aspectRatios.length;
    const currentCls = aspectRatios[currentAspectIdx];
    
    // Remove all aspect classes
    aspectRatios.forEach(cls => el.videoPlayer.classList.remove(cls));
    el.videoPlayer.classList.add(currentCls);
    
    el.aspectRatioBtn.textContent = aspectLabels[currentCls];
    triggerOsdBriefly();
  };

  // 8. PICTURE IN PICTURE & FULLSCREEN
  window.togglePiP = function () {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture();
    } else if (el.videoPlayer.requestPictureInPicture) {
      el.videoPlayer.requestPictureInPicture().catch(console.error);
    }
  };

  window.toggleFullscreen = function () {
    if (!document.fullscreenElement) {
      if (el.videoWrapper.requestFullscreen) {
        el.videoWrapper.requestFullscreen();
      } else if (el.videoWrapper.webkitRequestFullscreen) {
        el.videoWrapper.webkitRequestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  };

  // 9. FAVORITES (STAR) TOGGLE
  window.toggleFavorite = function (chId, e) {
    if (e) e.stopPropagation();
    if (favorites.has(chId)) {
      favorites.delete(chId);
    } else {
      favorites.add(chId);
    }
    localStorage.setItem(STORAGE_FAVS, JSON.stringify(Array.from(favorites)));

    // Re-render
    filterAndRenderChannels();
  };

  // 10. INTELLIGENT EPG GENERATOR
  function generateDynamicEpg(ch) {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMin = now.getMinutes();

    // 1-hour program blocks
    const startHour = currentHour;
    const endHour = (currentHour + 1) % 24;
    const progress = Math.round((currentMin / 60) * 100);
    const remainingMin = 60 - currentMin;

    const startStr = `${String(startHour).padStart(2, '0')}:00`;
    const endStr = `${String(endHour).padStart(2, '0')}:00`;

    // Dynamic programs based on channel genre
    const name = ch.name.toUpperCase();
    const grp = ch.group.toUpperCase();
    
    let currentShow = 'Live Satellite Broadcast';
    let nextShow = 'Evening Prime Showcase';

    if (grp.includes('SPORT') || name.includes('SPORT') || name.includes('CRICKET')) {
      const sportsShows = [
        'Live: ICC & T20 League Championship',
        'Premier Football League Matchday',
        'World Sports Action & Highlights',
        'Cricket Extra: Post Match Analysis',
        'Live Tennis Grand Tour'
      ];
      currentShow = sportsShows[currentHour % sportsShows.length];
      nextShow = sportsShows[(currentHour + 1) % sportsShows.length];
    } else if (grp.includes('MOVIE') || grp.includes('CINEMA') || name.includes('CINEMA')) {
      const movieShows = [
        'Blockbuster Premiere: Action Thriller',
        'Afternoon Superhit Matinee',
        'Golden Classic Cinema Hour',
        'Mega Star Weekend Special',
        'Hollywood Action Late Night'
      ];
      currentShow = movieShows[currentHour % movieShows.length];
      nextShow = movieShows[(currentHour + 1) % movieShows.length];
    } else if (grp.includes('NEWS') || name.includes('NEWS')) {
      const newsShows = [
        'Top Headlines & Morning Edition',
        'Prime Time Debate with Anchor',
        'The Nation at 9: Special Report',
        'Global Business & Market Watch',
        'Special Investigation & Ground Zero'
      ];
      currentShow = newsShows[currentHour % newsShows.length];
      nextShow = newsShows[(currentHour + 1) % newsShows.length];
    } else if (grp.includes('INDIA') || name.includes('STAR') || name.includes('ZEE') || name.includes('SONY')) {
      const hindiShows = [
        'Super Serial: Kahani Prime Time',
        'Family Drama Mega Episode',
        'Music Countdown & Bollywood Hits',
        'Comedy Stars Weekend Championship',
        'Grand Reality Show Live'
      ];
      currentShow = hindiShows[currentHour % hindiShows.length];
      nextShow = hindiShows[(currentHour + 1) % hindiShows.length];
    }

    return { currentShow, nextShow, progress, startStr, endStr, remainingMin };
  }

  // 11. KEYBOARD NAVIGATION & REMOTE CONTROL
  function handleGlobalKeydown(e) {
    // If typing in search box or settings input, skip shortcuts
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
      if (e.key === 'Escape') {
        document.activeElement.blur();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowUp':
      case 'k':
      case '[':
        e.preventDefault();
        zapChannel(-1);
        break;
      case 'ArrowDown':
      case 'j':
      case ']':
        e.preventDefault();
        zapChannel(1);
        break;
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        toggleFullscreen();
        break;
      case 'm':
      case 'M':
        e.preventDefault();
        toggleMute();
        break;
      case 'p':
      case 'P':
        e.preventDefault();
        togglePiP();
        break;
      case 'a':
      case 'A':
        e.preventDefault();
        cycleAspectRatio();
        break;
      case '/':
        e.preventDefault();
        el.channelSearch.focus();
        break;
      case '?':
        toggleKeyboardModal();
        break;
      case 'Escape':
        closeSettingsModal();
        closeKeyboardModal();
        closeEpgModal();
        break;
    }
  }

  // 12. SEARCH HELPERS
  window.clearSearch = function () {
    el.channelSearch.value = '';
    searchQuery = '';
    el.searchClearBtn.style.display = 'none';
    filterAndRenderChannels();
  };

  window.changeSort = function (val) {
    currentSort = val;
    filterAndRenderChannels();
  };

  // 13. MODALS LOGIC
  window.openSettingsModal = function () {
    const savedBackend = localStorage.getItem('novastream_backend_url') || '';
    const backendInput = document.getElementById('backendInput');
    if (backendInput) backendInput.value = savedBackend;
    el.settingsModal.style.display = 'flex';
  };
  window.closeSettingsModal = function () { el.settingsModal.style.display = 'none'; };
  
  window.toggleKeyboardModal = function () {
    el.shortcutsModal.style.display = (el.shortcutsModal.style.display === 'flex') ? 'none' : 'flex';
  };
  window.closeKeyboardModal = function () { el.shortcutsModal.style.display = 'none'; };

  window.openEpgModal = function () {
    el.epgModal.style.display = 'flex';
    renderEpgTimeline();
  };
  window.closeEpgModal = function () { el.epgModal.style.display = 'none'; };

  window.copyPlaylistUrl = function () {
    const url = 'https://tataplaym3u.zonmp.net/';
    navigator.clipboard.writeText(url).then(() => {
      alert('Copied Tata Play M3U URL!\nPaste this into VLC, TiviMate, or OTT Navigator.');
    }).catch(() => {
      prompt('Copy this M3U URL for VLC/TiviMate/OTT Navigator:', url);
    });
  };

  function renderEpgTimeline() {
    let html = '';
    displayedChannels.slice(0, 20).forEach(c => {
      const epg = generateDynamicEpg(c);
      html += `
        <div style="background:rgba(255,255,255,0.04);border:1px solid var(--border-glass);padding:10px 14px;border-radius:var(--radius-md);display:flex;align-items:center;gap:14px;">
          <div style="width:130px;font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${c.name}
          </div>
          <div style="flex:1;">
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
              <span style="color:#ffffff;font-weight:600;">${epg.currentShow}</span>
              <span style="color:var(--text-muted);font-size:11px;">${epg.startStr} - ${epg.endStr}</span>
            </div>
            <div style="height:4px;background:rgba(255,255,255,0.1);border-radius:2px;overflow:hidden;">
              <div style="height:100%;width:${epg.progress}%;background:var(--accent-cyan);"></div>
            </div>
          </div>
          <div style="width:150px;font-size:11.5px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            Next: ${epg.nextShow}
          </div>
        </div>`;
    });
    el.epgTimelineGrid.innerHTML = html;
  }

  window.saveSettings = function () {
    const newM3u = document.getElementById('m3uInput').value.trim();
    const backendInput = document.getElementById('backendInput');
    if (backendInput) {
      localStorage.setItem('novastream_backend_url', backendInput.value.trim());
    }
    closeSettingsModal();
    if (newM3u) {
      fetchPlaylist(newM3u);
    }
    if (currentChannel) {
      playChannel(currentChannel);
    }
  };

  window.reloadPlaylistFromServer = function () {
    closeSettingsModal();
    fetchPlaylist('https://tataplaym3u.zonmp.net/');
  };

  function resumeLastChannel() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_LAST_CHANNEL));
      if (saved && allChannels.some(c => c.id === saved.id)) {
        playChannel(saved);
        return;
      }
    } catch (e) {}

    // Default to first Indian channel or channel #1
    const indianCh = allChannels.find(c => c.group.toUpperCase().includes('INDIA') || c.name.toUpperCase().includes('HINDI'));
    if (indianCh) {
      playChannel(indianCh);
    } else if (allChannels.length > 0) {
      playChannel(allChannels[0]);
    }
  }

  // Boot Application
  document.addEventListener('DOMContentLoaded', initApp);

})();
