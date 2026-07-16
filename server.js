require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const morgan = require('morgan');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3001;
//const FILE_DATA_TIMEOUT_MS = 120000
app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));
app.use(morgan('tiny'));

const RAW_DIR = path.join(__dirname, 'raw');
fs.mkdirSync(RAW_DIR, { recursive: true });

let lastMessages = [];
const MAX_LAST = 200;
const DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_DEVICE_ID = 'default';
fs.mkdirSync(DATA_DIR, { recursive: true });

function normalizeDeviceId(deviceId) {
  if (typeof deviceId !== 'string' || !deviceId.trim()) return DEFAULT_DEVICE_ID;
  return deviceId.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getDeviceIdFromRequest(req) {
  const headerDeviceId =
    (typeof req?.get === 'function' &&
      (req.get('device') || req.get('deviceId') || req.get('x-device-id'))) ||
    req?.headers?.device ||
    req?.headers?.deviceid ||
    req?.headers?.['x-device-id'];

  return normalizeDeviceId(
    req?.query?.device ||
      req?.query?.deviceId ||
      req?.body?.device ||
      req?.body?.deviceId ||
      headerDeviceId
  );
}

function getDeviceIdFromWsRequest(req) {
  try {
    const reqUrl = req && req.url ? req.url : '/';
    const parsed = new URL(reqUrl, 'http://localhost');
    return normalizeDeviceId(parsed.searchParams.get('device'));
  } catch (e) {
    return DEFAULT_DEVICE_ID;
  }
}

function parseGnssId(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) return null;
    return value;
  }

  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  if (Number.isNaN(parsed) || parsed < 0) return null;
  return parsed;
}

function getGnssIdFromRequest(req) {
  const gnssId = req?.query?.gnss ?? req?.body?.gnss ?? req?.headers?.gnss;
  return parseGnssId(gnssId);
}

function getGnssIdFromWsRequest(req) {
  try {
    const reqUrl = req && req.url ? req.url : '/';
    const parsed = new URL(reqUrl, 'http://localhost');
    return parseGnssId(parsed.searchParams.get('gnss'));
  }
  catch (e) {
    return null;
  }
}

// Lấy đường dẫn tới file latest.json cho thiết bị
function getLatestJsonPath(deviceId) {
  return path.join(DATA_DIR, normalizeDeviceId(deviceId), 'latest.json');
}

// Lấy đường dẫn tới thư mục raw cho thiết bị
function getRawDirForDevice(deviceId) {
  return path.join(RAW_DIR, normalizeDeviceId(deviceId));
}

// Ghi dữ liệu telemetry mới nhất vào file latest.json cho thiết bị
function writeLatestForDevice(deviceId, messages) {
  const latestPath = getLatestJsonPath(deviceId);
  const latestDir = path.dirname(latestPath);
  fs.mkdirSync(latestDir, { recursive: true });

  try {
    const tmpPath = `${latestPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(messages, null, 2), 'utf-8');
    fs.renameSync(tmpPath, latestPath);
  } catch (e) {
    console.error(`Error persisting latest.json for device ${deviceId}`, e);
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableFiniteNumber(value) {
  return value === null || isFiniteNumber(value);
}

function hasOnlyKeys(obj, allowedKeys) {
  return Object.keys(obj).every(key => allowedKeys.includes(key));
}

// Chuẩn hóa dữ liệu vệ tinh (satellite) từ telemetry
function normalizeSatRecord(sat) {
  if (!sat || typeof sat !== 'object' || Array.isArray(sat)) return null;

  const elevationKeys = ['gnss', 'svid', 'elevation'];
  const signalKeys = ['gnss', 'svid', 'sigId', 'cn0', 'ccd', 'sigmaCcd', 's4'];

  if (
    hasOnlyKeys(sat, elevationKeys) &&
    isFiniteNumber(sat.gnss) &&
    isFiniteNumber(sat.svid) &&
    isFiniteNumber(sat.elevation)
  ) {
    return {
      gnss: sat.gnss,
      svid: sat.svid,
      elevation: sat.elevation,
    };
  }

  if (
    hasOnlyKeys(sat, signalKeys) &&
    isFiniteNumber(sat.gnss) &&
    isFiniteNumber(sat.svid) &&
    isFiniteNumber(sat.sigId) &&
    isNullableFiniteNumber(sat.cn0) &&
    isNullableFiniteNumber(sat.ccd) &&
    isNullableFiniteNumber(sat.sigmaCcd) &&
    isNullableFiniteNumber(sat.s4)
  ) {
    return {
      gnss: sat.gnss,
      svid: sat.svid,
      sigId: sat.sigId,
      cn0: sat.cn0,
      ccd: sat.ccd,
      sigmaCcd: sat.sigmaCcd,
      s4: sat.s4,
    };
  }

  return null;
}

const http = require('http');
const { WebSocketServer } = require('ws');

const server = http.createServer(app);

// Thiết lập WebSocket server
const wss = new WebSocketServer({ server });
const clients = new Set();
wss.on('connection', (socket, req) => {
  console.log('WebSocket client connected');
  clients.add(socket);
  const wsDeviceId = getDeviceIdFromWsRequest(req);
  const wsGnssId = getGnssIdFromWsRequest(req);

  const sendLatestData = async () => {
    let latest_data = lastMessages;
    try {
      const latestPath = getLatestJsonPath(wsDeviceId);
      const raw = await fs.promises.readFile(latestPath, 'utf-8');
      const raw_data = JSON.parse(raw);
      if (wsGnssId !== null) {
        latest_data = raw_data.map(record => ({
          ...record, // Copies all other record fields (like timestamp, id, etc.)
          sats: record.sats.filter(sat => sat.gnss === wsGnssId) // Overwrites sats with ONLY the matches
        }));
      }
      else {
        latest_data = raw_data;
      }
    } catch (e) {
      latest_data = [];
    }

    const liveData = {
      type: 'data',
      data: latest_data,
      timestamp: new Date().toISOString(),
    };
    try {
      socket.send(JSON.stringify(liveData));
    } catch (sendErr) {
      console.error('Failed to send websocket live data:', sendErr);
    }
  };

   // 2. Run it immediately on connection
  sendLatestData();

  // 3. Then repeat it every 5 seconds
  const interval = setInterval(sendLatestData, 10000);

  socket.on('close', () => {
    console.log('WebSocket client disconnected');
    clients.delete(socket);
    clearInterval(interval);
  });

  socket.on('error', err => {
    console.error('WebSocket error', err);
    clients.delete(socket);
    clearInterval(interval);
  });

  /*
  socket.on('message', msg => {
    console.log('ws msg', msg.toString());
  });
  */
});

// API nhận dữ liệu telemetry từ thiết bị
app.post('/telemetry', async (req, res)  => {
  try {
    const body = req.body;
    const deviceId = normalizeDeviceId(body && body.device);

    try {
      const latestPath = getLatestJsonPath(deviceId);
      const raw = await fs.promises.readFile(latestPath, 'utf-8');
      lastMessages = JSON.parse(raw);
    } catch (e) {
      lastMessages = [];
    }

    if (Array.isArray(body.telemetry)) {
      const normalizedTelemetry = [];

      for (let i = 0; i < body.telemetry.length; i += 1) {
        const record = body.telemetry[i];
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
          return res.status(400).json({
            ok: false,
            error: `invalid telemetry record at index ${i}`,
          });
        }

        if (typeof record.timestamp !== 'string' || !Array.isArray(record.sats)) {
          return res.status(400).json({
            ok: false,
            error: `invalid telemetry structure at index ${i}`,
          });
        }

        const normalizedSats = [];
        for (let j = 0; j < record.sats.length; j += 1) {
          const normalizedSat = normalizeSatRecord(record.sats[j]);
          if (!normalizedSat) {
            return res.status(400).json({
              ok: false,
              error: `invalid sat format at telemetry[${i}].sats[${j}]`,
            });
          }
          normalizedSats.push(normalizedSat);
        }

        normalizedTelemetry.push({
          timestamp: record.timestamp,
          sats: normalizedSats,
        });
      }

      normalizedTelemetry.forEach(record => {

        lastMessages.push({
          device: deviceId,
          timestamp: record.timestamp,
          sats: record.sats,
          _received: new Date().toISOString()
        });

        if (lastMessages.length > MAX_LAST) {
          lastMessages.shift();
        }
      });

      writeLatestForDevice(deviceId, lastMessages);

      return res.json({ ok: true, device: deviceId });
    }

    res.status(400).json({
      ok: false,
      error: 'invalid telemetry format'
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({
      ok: false,
      error: e.toString()
    });
  }
});

// Lấy dữ liệu telemetry mới nhất
app.get('/latest', (req, res) => {
  const deviceId = getDeviceIdFromRequest(req);
  const latestPath = getLatestJsonPath(deviceId);

  try {
    if (!fs.existsSync(latestPath)) {
      return res.json([]);
    }

    const raw = fs.readFileSync(latestPath, 'utf-8');
    return res.json(JSON.parse(raw));
  } catch (e) {
    console.error(`Failed to read latest telemetry for device ${deviceId}:`, e);
    return res.status(500).json({ ok: false, error: e.toString() });
  }
});

// Tải file raw UBX lên server
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const deviceId = getDeviceIdFromRequest(req);
    const rawDir = getRawDirForDevice(deviceId);
    fs.mkdirSync(rawDir, { recursive: true });
    cb(null, rawDir);
  },
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage });

// API tải file raw UBX lên server
app.post('/uploadRaw', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'file missing' });
  const deviceId = getDeviceIdFromRequest(req);
  res.json({ ok: true, name: req.file.filename, device: deviceId });
});

// Download file raw UBX 
app.get('/raw/:fname', (req, res) => {
  const deviceId = getDeviceIdFromRequest(req);
  const fname = path.basename(req.params.fname);
  const p = path.join(getRawDirForDevice(deviceId), fname);
  if (!fs.existsSync(p)) return res.status(404).send('not found');
  res.download(p);
});

// API lấy danh sách file raw
app.get('/api/files', (req, res) => {
  const deviceId = getDeviceIdFromRequest(req);
  const rawDir = getRawDirForDevice(deviceId);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 10, 1), 200);
  const dateQuery = typeof req.query.date === 'string' ? req.query.date.trim() : '';
  const normalizedDate = dateQuery.replace(/[^0-9]/g, '').slice(0, 8);

  fs.readdir(rawDir, (err, files) => {
    if (err) {
      if (err.code === 'ENOENT') return res.json([]);
      return res.status(500).json({ ok: false, error: err.toString() });
    }

    let filteredFiles = files;
    if (normalizedDate) {
      filteredFiles = filteredFiles.filter(name => name.startsWith(normalizedDate));
    }

    filteredFiles = filteredFiles.sort().reverse();

    const total = filteredFiles.length;
    const totalPages = Math.max(Math.ceil(total / pageSize), 1);
    const currentPage = Math.min(page, totalPages);
    const start = (currentPage - 1) * pageSize;
    const paged = filteredFiles.slice(start, start + pageSize);
    const items = paged.map(f => ({ path: `/raw/${f}?device=${encodeURIComponent(deviceId)}`, name: f }));

    res.json({
      items,
      pagination: {
        page: currentPage,
        pageSize,
        total,
        totalPages,
      },
      filters: {
        date: normalizedDate || null,
      },
    });
  });
});

app.get('/api/fileData/:fname', (req, res) => {
  const deviceId = getDeviceIdFromRequest(req);
  const gnssId = getGnssIdFromRequest(req);
  const fname = path.basename(req.params.fname);
  const p = path.join(getRawDirForDevice(deviceId), fname);
  if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: 'file not found' });

  const pythonBin = process.env.PYTHON_BIN || 'python3';
  const args = ['python/ubx_reader.py', '--device', deviceId, '--file', p];
  if (gnssId !== null) {
    args.push('--gnss', String(gnssId));
  }
  const py = spawn(pythonBin, args, { cwd: __dirname });

  let stderr = '';
  let sent = false;
  let responseStarted = false;
  /*const timer = setTimeout(() => {
    if (sent) return;
    sent = true;
    py.kill();
    return res.status(504).json({
      ok: false,
      error: `Python processing timed out after ${FILE_DATA_TIMEOUT_MS}ms`,
    });
  }, FILE_DATA_TIMEOUT_MS);
  */
  py.stdout.on('data', chunk => {
    if (!responseStarted) {
      responseStarted = true;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.write(chunk);
  });

  py.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });

  py.on('error', err => {
    if (sent) return;
    sent = true;
    //clearTimeout(timer);
    console.error('Failed to start Python process:', err);
    res.status(500).json({ ok: false, error: 'Failed to start Python process' });
  });

  py.on('close', code => {
    if (sent) return;
    //clearTimeout(timer);

    if (code !== 0) {
      sent = true;
      console.error(`Python process exited with code ${code}`);
      if (stderr) {
        console.error(stderr);
      }
      if (responseStarted) {
        return res.end();
      }
      return res.status(500).json({ ok: false, error: `Python process exited with code ${code}` });
    }

    sent = true;
    if (!responseStarted) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    return res.end();
  });
});

server.listen(PORT, () => {
  console.log(`UBX backend listening on port ${PORT}`);
});