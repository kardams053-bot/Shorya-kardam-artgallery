const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'shorya-admin-2026';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]');

const allowedImage = /\.(jpg|jpeg|png|webp)$/i;
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(5).toString('hex')}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_, file, cb) => cb(null, allowedImage.test(file.originalname))
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(ROOT, 'public')));

function readOrders() { return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); }
function writeOrders(orders) { fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2)); }
function makeOrderId() {
  const d = new Date();
  const date = d.toISOString().slice(0,10).replace(/-/g,'');
  return `SKA-${date}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}
function auth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.post('/api/orders', upload.single('referencePhoto'), (req, res) => {
  try {
    const { artwork, size, persons, name, phone, email, address, city, state, pincode, country, delivery } = req.body;
    if (!artwork || !size || !name || !phone || !address || !city || !pincode || !req.file) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Please complete all required fields and upload a reference photo.' });
    }
    const personCount = Math.max(1, Number(persons || 1));
    const priceTable = {
      'Graphite Pencil Portrait': { A4: 589, A3: 999 },
      'Oil Pastel Portrait': { A4: 689, A3: 1399 },
      'Pencil Colour Portrait': { A4: 899, A3: 1499 }
    };
    const base = priceTable[artwork]?.[size];
    if (!base) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'Invalid artwork or size.' }); }
    let artworkTotal = base;
    if (personCount > 1) {
      const extras = artwork === 'Graphite Pencil Portrait' ? 400 : artwork === 'Oil Pastel Portrait' ? 400 : 400;
      artworkTotal += extras * (personCount - 1);
    }
    const deliveryFee = delivery === 'International' ? 400 : 150;
    const total = artworkTotal + deliveryFee;
    const order = {
      id: makeOrderId(), createdAt: new Date().toISOString(),
      artwork, size, persons: personCount, artworkTotal, delivery, deliveryFee, total,
      customer: { name, phone, email: email || '', address, city, state: state || '', pincode, country: country || 'India' },
      referencePhoto: path.basename(req.file.path),
      paymentMethod: null, paymentStatus: 'Awaiting payment choice', utr: '', paymentScreenshot: '', status: 'New'
    };
    const orders = readOrders(); orders.unshift(order); writeOrders(orders);
    res.json({ ok: true, orderId: order.id, total: order.total, deliveryFee: order.deliveryFee, artworkTotal: order.artworkTotal });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Could not create order.' });
  }
});

app.post('/api/orders/:id/payment', upload.single('paymentScreenshot'), (req, res) => {
  try {
    const orders = readOrders();
    const order = orders.find(o => o.id === req.params.id);
    if (!order) { if (req.file) fs.unlinkSync(req.file.path); return res.status(404).json({ error: 'Order not found.' }); }
    const method = req.body.paymentMethod;
    if (!['UPI', 'COD'].includes(method)) { if (req.file) fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'Choose UPI or COD.' }); }
    if (method === 'UPI' && !req.body.utr) { if (req.file) fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'Please enter the UTR / transaction ID.' }); }
    if (method === 'UPI' && !req.file) return res.status(400).json({ error: 'Please upload the payment screenshot.' });
    order.paymentMethod = method;
    order.paymentStatus = method === 'COD' ? 'COD selected' : 'Payment proof submitted';
    order.utr = method === 'UPI' ? String(req.body.utr).trim() : '';
    order.paymentScreenshot = req.file ? path.basename(req.file.path) : '';
    order.status = 'Order Confirmed';
    order.updatedAt = new Date().toISOString();
    writeOrders(orders);
    res.json({ ok: true, message: method === 'COD' ? 'COD order confirmed.' : 'Payment details submitted. We will verify your payment.' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not save payment.' }); }
});

app.get('/api/orders/:id', (req, res) => {
  const order = readOrders().find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const safe = { id: order.id, createdAt: order.createdAt, artwork: order.artwork, size: order.size, persons: order.persons, total: order.total, delivery: order.delivery, paymentMethod: order.paymentMethod, paymentStatus: order.paymentStatus, status: order.status };
  res.json(safe);
});

app.get('/api/admin/orders', auth, (_, res) => res.json(readOrders()));
app.patch('/api/admin/orders/:id', auth, (req, res) => {
  const allowed = ['New','Order Confirmed','Payment Verified','In Progress','Ready to Ship','Shipped','Delivered','Cancelled'];
  const orders = readOrders(); const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (req.body.status && allowed.includes(req.body.status)) order.status = req.body.status;
  if (req.body.paymentStatus) order.paymentStatus = req.body.paymentStatus;
  order.updatedAt = new Date().toISOString(); writeOrders(orders); res.json({ ok: true, order });
});
app.get('/api/admin/file/:filename', auth, (req, res) => {
  const filename = path.basename(req.params.filename);
  const file = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.listen(PORT, () => console.log(`Shorya Kardam Art running on port ${PORT}`));
