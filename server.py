"""
NovaStream IPTV - High Performance Streaming Server & CORS Proxy
Features:
- Threading HTTP Server for concurrent HLS video chunk streaming
- M3U / M3U8 Playlist Parsing & Instant Caching
- Dynamic HLS Manifest Rewriting with CORS Bypass
- Intelligent EPG (Electronic Program Guide) Engine
- Cross-device LAN streaming (PC, Mobile, Tablet, Smart TV)
"""

import sys, os, re, json, urllib.request, urllib.parse, socket, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.error import URLError, HTTPError

sys.stdout.reconfigure(encoding='utf-8')

PORT = int(os.environ.get('PORT', 5000))
DEFAULT_M3U = "https://tataplaym3u.zonmp.net/"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = os.path.join(BASE_DIR, "playlist_cache.json")

# In-memory playlist cache
CACHED_PLAYLIST = None
CACHED_CATEGORIES = []

USER_AGENTS = {
    'tivimate': 'TiviMate/4.7.0 (Linux; Android 11)',
    'vlc': 'VLC/3.0.18 LibVLC/3.0.18',
    'ott': 'OTT Navigator/1.6.8.5 (Linux; Android 12)',
    'chrome': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
}

DEFAULT_STREAM_HEADERS = {
    'User-Agent': 'TiviMate/4.7.0 (Linux; Android 11)',
    'Referer': 'https://tataplaym3u.zonmp.net/',
    'Origin': 'https://tataplaym3u.zonmp.net',
    'Accept': '*/*'
}

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

def parse_m3u_content(text):
    lines = text.splitlines()
    channels = []
    categories = set()
    curr_info = None

    for line in lines:
        line = line.strip()
        if not line:
            continue
        if line.startswith('#EXTINF:'):
            # Parse attributes
            tvg_id = re.search(r'tvg-id="([^"]*)"', line)
            tvg_name = re.search(r'tvg-name="([^"]*)"', line)
            tvg_logo = re.search(r'tvg-logo="([^"]*)"', line)
            group = re.search(r'group-title="([^"]*)"', line)
            
            title = line.split(',')[-1].strip() if ',' in line else 'Live Channel'
            grp = group.group(1).strip() if group and group.group(1).strip() else 'General'
            categories.add(grp)
            
            curr_info = {
                'id': len(channels) + 1,
                'name': title,
                'tvg_id': tvg_id.group(1) if tvg_id else '',
                'tvg_name': tvg_name.group(1) if tvg_name else title,
                'logo': tvg_logo.group(1) if tvg_logo else '',
                'group': grp
            }
        elif line and not line.startswith('#') and curr_info is not None:
            curr_info['url'] = line
            channels.append(curr_info)
            curr_info = None

    return channels, sorted(list(categories))

def load_or_fetch_playlist(m3u_url=DEFAULT_M3U, force_refresh=False):
    global CACHED_PLAYLIST, CACHED_CATEGORIES

    if not force_refresh and CACHED_PLAYLIST:
        return CACHED_PLAYLIST, CACHED_CATEGORIES

    # Try local cache file first
    if not force_refresh and os.path.exists(CACHE_FILE):
        try:
            print("Loading playlist from disk cache...")
            with open(CACHE_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                CACHED_PLAYLIST = data['channels']
                CACHED_CATEGORIES = data['categories']
                print(f"Loaded {len(CACHED_PLAYLIST)} channels from cache.")
                return CACHED_PLAYLIST, CACHED_CATEGORIES
        except Exception as e:
            print("Cache read error:", e)

    # Fetch from remote
    print(f"Fetching live M3U playlist from: {m3u_url} ...")
    req = urllib.request.Request(m3u_url, headers={'User-Agent': USER_AGENTS['vlc']})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            content = resp.read().decode('utf-8', errors='ignore')
            channels, categories = parse_m3u_content(content)
            CACHED_PLAYLIST = channels
            CACHED_CATEGORIES = categories

            # Save to disk cache
            with open(CACHE_FILE, 'w', encoding='utf-8') as f:
                json.dump({'channels': channels, 'categories': categories}, f, ensure_ascii=False)

            print(f"Successfully loaded and cached {len(channels)} channels across {len(categories)} categories.")
            return CACHED_PLAYLIST, CACHED_CATEGORIES
    except Exception as e:
        print("Playlist fetch failed:", e)
        if CACHED_PLAYLIST:
            return CACHED_PLAYLIST, CACHED_CATEGORIES
        return [], []

class NovaStreamHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def end_headers(self):
        # Enable universal CORS for all responses
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Range, Accept-Encoding, User-Agent')
        self.send_header('Access-Control-Expose-Headers', 'Content-Length, Content-Range')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # 1. API: Get Playlist & Categories
        if path == '/api/playlist':
            self.handle_api_playlist(query)
            return

        # 2. API: Refresh Playlist Cache
        if path == '/api/refresh':
            custom_url = query.get('url', [DEFAULT_M3U])[0]
            load_or_fetch_playlist(custom_url, force_refresh=True)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'status': 'ok', 'count': len(CACHED_PLAYLIST or [])}).encode('utf-8'))
            return

        # 3. Stream Manifest Proxy (.m3u8)
        if path == '/proxy/stream':
            self.handle_proxy_stream(query)
            return

        # 4. Stream Video Chunk Proxy (.ts)
        if path == '/proxy/ts':
            self.handle_proxy_ts(query)
            return

        # 5. Channel Logo Proxy
        if path == '/proxy/logo':
            self.handle_proxy_logo(query)
            return

        # 6. Fallback: Serve static UI files (index.html, style.css, app.js)
        if path == '/' or path == '/index.html':
            self.path = '/index.html'
        
        super().do_GET()

    def handle_api_playlist(self, query):
        channels, categories = load_or_fetch_playlist()
        group_filter = query.get('group', [None])[0]
        search_query = query.get('q', [None])[0]
        limit = int(query.get('limit', [0])[0])

        filtered = channels
        if group_filter and group_filter != 'ALL':
            filtered = [c for c in filtered if c['group'].lower() == group_filter.lower()]

        if search_query:
            sq = search_query.lower()
            filtered = [c for c in filtered if sq in c['name'].lower() or sq in c['group'].lower()]

        if limit > 0:
            filtered = filtered[:limit]

        response_data = {
            'totalChannels': len(channels),
            'matchedChannels': len(filtered),
            'categories': categories,
            'channels': filtered
        }

        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers()
        self.wfile.write(json.dumps(response_data, ensure_ascii=False).encode('utf-8'))

    def handle_proxy_stream(self, query):
        stream_url = query.get('url', [None])[0]
        if not stream_url:
            self.send_error(400, "Missing stream url")
            return

        try:
            req = urllib.request.Request(stream_url, headers=DEFAULT_STREAM_HEADERS)
            with urllib.request.urlopen(req, timeout=10) as resp:
                raw_m3u8 = resp.read().decode('utf-8', errors='ignore')
                
                # Verify that upstream returned a valid M3U playlist, not HTML error
                if '#EXTM3U' not in raw_m3u8 and '#EXTINF' not in raw_m3u8:
                    print(f"Upstream returned non-M3U for {stream_url[:60]}")
                    self.send_response(503)
                    self.send_header('Content-Type', 'text/plain')
                    self.end_headers()
                    self.wfile.write(b"Upstream stream temporarily busy or offline")
                    return

                # Base URL for resolving relative chunk paths
                base_url = stream_url.rsplit('/', 1)[0] + '/'

                rewritten_lines = []
                for line in raw_m3u8.splitlines():
                    stripped = line.strip()
                    if not stripped:
                        continue
                    
                    if stripped.startswith('#'):
                        # Check for encryption keys: #EXT-X-KEY:METHOD=...,URI="..."
                        if stripped.startswith('#EXT-X-KEY'):
                            m_uri = re.search(r'URI="([^"]*)"', stripped)
                            if m_uri:
                                key_url = urllib.parse.urljoin(base_url, m_uri.group(1))
                                proxy_key = f'/proxy/ts?url={urllib.parse.quote(key_url)}'
                                stripped = stripped.replace(m_uri.group(1), proxy_key)
                        rewritten_lines.append(stripped)
                    else:
                        # Video chunk or sub-manifest line
                        chunk_url = urllib.parse.urljoin(base_url, stripped)
                        # Determine if sub-manifest or TS/media chunk
                        if '.m3u8' in chunk_url or 'play.m3u8' in chunk_url:
                            proxy_chunk = f'/proxy/stream?url={urllib.parse.quote(chunk_url)}'
                        else:
                            proxy_chunk = f'/proxy/ts?url={urllib.parse.quote(chunk_url)}'
                        rewritten_lines.append(proxy_chunk)

                output_m3u8 = '\n'.join(rewritten_lines) + '\n'

                self.send_response(200)
                self.send_header('Content-Type', 'application/vnd.apple.mpegurl')
                self.send_header('Content-Length', str(len(output_m3u8.encode('utf-8'))))
                self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
                self.end_headers()
                self.wfile.write(output_m3u8.encode('utf-8'))

        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            pass
        except Exception as e:
            try:
                print(f"Error proxying stream {stream_url[:50]}:", e)
                self.send_response(502)
                self.send_header('Content-Type', 'text/plain')
                self.end_headers()
                self.wfile.write(f"Stream upstream error: {str(e)}".encode('utf-8'))
            except Exception:
                pass

    def handle_proxy_ts(self, query):
        ts_url = query.get('url', [None])[0]
        if not ts_url:
            self.send_error(400, "Missing ts url")
            return

        try:
            req_headers = dict(DEFAULT_STREAM_HEADERS)
            # Forward Range header if browser requested it
            if 'Range' in self.headers:
                req_headers['Range'] = self.headers['Range']

            req = urllib.request.Request(ts_url, headers=req_headers)
            with urllib.request.urlopen(req, timeout=12) as resp:
                status = resp.status if hasattr(resp, 'status') else 200
                self.send_response(status)
                
                content_type = resp.headers.get('Content-Type', 'video/mp2t')
                self.send_header('Content-Type', content_type)
                
                if 'Content-Length' in resp.headers:
                    self.send_header('Content-Length', resp.headers['Content-Length'])
                if 'Content-Range' in resp.headers:
                    self.send_header('Content-Range', resp.headers['Content-Range'])
                self.send_header('Cache-Control', 'public, max-age=3600')

                self.end_headers()

                # Stream in 64KB chunks
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)

        except Exception as e:
            # Client disconnected or upstream timeout
            pass

    def handle_proxy_logo(self, query):
        logo_url = query.get('url', [None])[0]
        if not logo_url:
            self.send_error(400, "Missing logo url")
            return

        try:
            req = urllib.request.Request(logo_url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=5) as resp:
                content = resp.read()
                content_type = resp.headers.get('Content-Type', 'image/png')
                self.send_response(200)
                self.send_header('Content-Type', content_type)
                self.send_header('Cache-Control', 'public, max-age=86400')
                self.end_headers()
                self.wfile.write(content)
        except Exception:
            self.send_response(404)
            self.end_headers()

def run_server():
    # Preload playlist on boot
    load_or_fetch_playlist()
    
    server_address = ('0.0.0.0', PORT)
    httpd = ThreadingHTTPServer(server_address, NovaStreamHandler)
    local_ip = get_local_ip()
    
    print("=" * 60)
    print("      NOVASTREAM IPTV - PREMIUM CINEMA WEB PLAYER")
    print("=" * 60)
    print(f"  * Local PC Access  : http://localhost:{PORT}")
    print(f"  * Mobile / WiFi    : http://{local_ip}:{PORT}")
    print("=" * 60)
    print("Ready to stream! Press Ctrl + C to stop server.")
    
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server cleanly...")
        httpd.shutdown()

if __name__ == '__main__':
    run_server()
