const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const QRCode = require("qrcode");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/agritrace";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-local-development-secret";

app.use(express.json({ limit: "2mb" }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, "public")));

const eventSchema = new mongoose.Schema({
  type: { type: String, enum: ["Harvest", "Transport", "Storage", "Price Update", "Distribution", "Delivery", "Quality Check", "Inventory Update", "Payment"], required: true },
  location: { type: String, required: true, trim: true },
  description: { type: String, required: true, trim: true },
  recordedBy: { type: String, default: "AgriTrace user", trim: true },
  recordedAt: { type: Date, default: Date.now },
  temperatureC: Number,
  pricePerKg: { type: Number, min: 0 },
  latitude: Number,
  longitude: Number,
  quantityKg: Number
}, { timestamps: true });

const qualitySchema = new mongoose.Schema({
  checkedAt: { type: Date, default: Date.now },
  checkedBy: { type: String, required: true },
  grade: { type: String, enum: ["A", "B", "C", "Rejected"], default: "A" },
  notes: { type: String, default: "" },
  temperatureC: Number,
  rejectedKg: { type: Number, default: 0, min: 0 }
});

const paymentSchema = new mongoose.Schema({
  invoiceNo: { type: String, required: true, unique: true },
  payer: { type: String, required: true },
  payee: { type: String, required: true },
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: "INR" },
  method: { type: String, enum: ["Cash", "UPI", "Bank Transfer", "Card", "Other"], default: "UPI" },
  status: { type: String, enum: ["Pending", "Paid", "Overdue", "Cancelled"], default: "Pending" },
  dueDate: Date,
  paidAt: Date,
  notes: { type: String, default: "" }
}, { timestamps: true });

const produceSchema = new mongoose.Schema({
  batchId: { type: String, required: true, unique: true, trim: true, uppercase: true },
  productName: { type: String, required: true, trim: true },
  variety: { type: String, default: "", trim: true },
  farmerName: { type: String, required: true, trim: true },
  farmLocation: { type: String, required: true, trim: true },
  harvestDate: { type: Date, required: true },
  expiryDate: Date,
  quantityKg: { type: Number, required: true, min: 0.01 },
  availableKg: { type: Number, min: 0 },
  wastageKg: { type: Number, default: 0, min: 0 },
  pricePerKg: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ["Harvested", "In Transit", "Stored", "Distributed", "Delivered", "Quality Hold", "Expired"], default: "Harvested" },
  destination: { type: String, default: "", trim: true },
  latitude: Number,
  longitude: Number,
  events: { type: [eventSchema], default: [] },
  qualityChecks: { type: [qualitySchema], default: [] },
  payments: { type: [paymentSchema], default: [] }
}, { timestamps: true });

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ["Admin", "Farmer", "Transporter", "Warehouse Manager", "Distributor", "Retailer"], default: "Farmer" },
  active: { type: Boolean, default: true }
}, { timestamps: true });

const notificationSchema = new mongoose.Schema({
  message: { type: String, required: true },
  type: { type: String, default: "info" },
  batchId: String,
  read: { type: Boolean, default: false }
}, { timestamps: true });

const Produce = mongoose.model("Produce", produceSchema);
const User = mongoose.model("User", userSchema);
const Notification = mongoose.model("Notification", notificationSchema);
const Payment = mongoose.model("Payment", paymentSchema);

function cleanError(err) {
  if (err.code === 11000) return "That ID or email already exists. Choose a unique value.";
  return err.message || "Something went wrong.";
}
function asyncRoute(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ message: "Please log in first." });
  next();
}
function allowRoles(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ message: "Please log in first." });
    if (!roles.includes(req.session.user.role)) return res.status(403).json({ message: "Your role does not have permission for this action." });
    next();
  };
}
async function notify(message, type = "info", batchId = "") {
  await Notification.create({ message, type, batchId });
}
function asPublicUser(user) {
  return { id: user._id, name: user.name, email: user.email, role: user.role };
}

app.get("/api/health", (req, res) => res.json({
  ok: true, app: "AgriTrace",
  database: mongoose.connection.readyState === 1 ? "connected" : "disconnected"
}));
app.get("/api/setup-status", asyncRoute(async (req, res) => {
  res.json({ needsAdmin: (await User.countDocuments()) === 0 });
}));
app.post("/api/setup", asyncRoute(async (req, res) => {
  if (await User.countDocuments()) return res.status(409).json({ message: "Setup is already complete. Please log in." });
  const { name, email, password } = req.body;
  if (!name || !email || !password || String(password).length < 8) return res.status(400).json({ message: "Enter name, email, and a password of at least 8 characters." });
  const user = await User.create({ name, email, passwordHash: await bcrypt.hash(password, 12), role: "Admin" });
  req.session.user = asPublicUser(user);
  await notify("AgriTrace administrator account created.", "success");
  res.status(201).json({ user: req.session.user });
}));
app.post("/api/login", asyncRoute(async (req, res) => {
  const user = await User.findOne({ email: String(req.body.email || "").toLowerCase().trim(), active: true });
  if (!user || !(await bcrypt.compare(String(req.body.password || ""), user.passwordHash))) {
    return res.status(401).json({ message: "Invalid email or password." });
  }
  req.session.user = asPublicUser(user);
  res.json({ user: req.session.user });
}));
app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get("/api/me", (req, res) => res.json({ user: req.session.user || null }));

app.get("/api/users", requireAuth, allowRoles("Admin"), asyncRoute(async (req, res) => {
  const users = await User.find().select("-passwordHash").sort({ createdAt: -1 });
  res.json(users);
}));
app.post("/api/users", requireAuth, allowRoles("Admin"), asyncRoute(async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || String(password).length < 8) return res.status(400).json({ message: "Name, email and a password of at least 8 characters are required." });
  const allowed = ["Admin", "Farmer", "Transporter", "Warehouse Manager", "Distributor", "Retailer"];
  if (!allowed.includes(role)) return res.status(400).json({ message: "Invalid role." });
  const user = await User.create({ name, email, role, passwordHash: await bcrypt.hash(password, 12) });
  res.status(201).json({ id: user._id, name: user.name, email: user.email, role: user.role });
}));
app.patch("/api/users/:id", requireAuth, allowRoles("Admin"), asyncRoute(async (req, res) => {
  const update = {};
  if (typeof req.body.active === "boolean") update.active = req.body.active;
  if (req.body.role && ["Admin", "Farmer", "Transporter", "Warehouse Manager", "Distributor", "Retailer"].includes(req.body.role)) update.role = req.body.role;
  const user = await User.findByIdAndUpdate(req.params.id, update, { new: true }).select("-passwordHash");
  if (!user) return res.status(404).json({ message: "User not found." });
  res.json(user);
}));

app.get("/api/produce", requireAuth, asyncRoute(async (req, res) => {
  const filter = {};
  if (req.query.status && req.query.status !== "All") filter.status = req.query.status;
  if (req.query.search) {
    const safe = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(safe, "i");
    filter.$or = ["batchId", "productName", "farmerName", "farmLocation", "destination"].map(k => ({ [k]: rx }));
  }
  res.json(await Produce.find(filter).sort({ createdAt: -1 }).lean());
}));
app.post("/api/produce", requireAuth, allowRoles("Admin", "Farmer"), asyncRoute(async (req, res) => {
  const body = { ...req.body, batchId: String(req.body.batchId || "").trim().toUpperCase() };
  body.availableKg = body.availableKg === undefined ? Number(body.quantityKg) : Number(body.availableKg);
  const record = await Produce.create(body);
  await notify(`New batch ${record.batchId} created: ${record.productName}.`, "success", record.batchId);
  res.status(201).json(record);
}));
app.patch("/api/produce/:id", requireAuth, allowRoles("Admin", "Farmer", "Warehouse Manager", "Distributor"), asyncRoute(async (req, res) => {
  const allowed = ["productName", "variety", "farmerName", "farmLocation", "harvestDate", "expiryDate", "quantityKg", "availableKg", "wastageKg", "pricePerKg", "status", "destination", "latitude", "longitude"];
  const update = {};
  for (const key of allowed) if (req.body[key] !== undefined) update[key] = req.body[key];
  const record = await Produce.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
  if (!record) return res.status(404).json({ message: "Batch not found." });
  await notify(`Batch ${record.batchId} updated.`, "info", record.batchId);
  res.json(record);
}));
app.delete("/api/produce/:id", requireAuth, allowRoles("Admin"), asyncRoute(async (req, res) => {
  const record = await Produce.findByIdAndDelete(req.params.id);
  if (!record) return res.status(404).json({ message: "Batch not found." });
  await notify(`Batch ${record.batchId} was deleted.`, "warning", record.batchId);
  res.json({ message: `Batch ${record.batchId} deleted.` });
}));

app.post("/api/produce/:id/events", requireAuth, asyncRoute(async (req, res) => {
  const record = await Produce.findById(req.params.id);
  if (!record) return res.status(404).json({ message: "Batch not found." });
  const event = { ...req.body, recordedBy: req.session.user.name };
  record.events.push(event);
  if (req.body.status) record.status = req.body.status;
  if (req.body.pricePerKg !== undefined && req.body.type === "Price Update") record.pricePerKg = Number(req.body.pricePerKg);
  if (req.body.quantityKg !== undefined && ["Distribution", "Delivery"].includes(req.body.type)) {
    const moved = Number(req.body.quantityKg);
    if (!Number.isFinite(moved) || moved <= 0 || moved > (record.availableKg ?? record.quantityKg)) {
      return res.status(400).json({ message: "Movement quantity must be positive and no greater than available stock." });
    }
    record.availableKg = Math.max(0, Number(record.availableKg ?? record.quantityKg) - moved);
  }
  await record.save();
  await notify(`${event.type}: batch ${record.batchId} — ${event.description}`, "info", record.batchId);
  res.status(201).json(record);
}));
app.post("/api/produce/:id/quality", requireAuth, allowRoles("Admin", "Farmer", "Warehouse Manager"), asyncRoute(async (req, res) => {
  const record = await Produce.findById(req.params.id);
  if (!record) return res.status(404).json({ message: "Batch not found." });
  const rejectedKg = Math.max(0, Number(req.body.rejectedKg || 0));
  if (rejectedKg > Number(record.availableKg ?? record.quantityKg)) return res.status(400).json({ message: "Rejected quantity exceeds available stock." });
  const check = { ...req.body, checkedBy: req.session.user.name, rejectedKg };
  record.qualityChecks.push(check);
  record.wastageKg = Number(record.wastageKg || 0) + rejectedKg;
  record.availableKg = Math.max(0, Number(record.availableKg ?? record.quantityKg) - rejectedKg);
  if (req.body.grade === "Rejected") record.status = "Quality Hold";
  record.events.push({ type: "Quality Check", location: req.body.location || record.destination || record.farmLocation, description: `Grade ${req.body.grade || "A"}: ${req.body.notes || "Quality inspection completed"}`, recordedBy: req.session.user.name });
  await record.save();
  await notify(`Quality check recorded for ${record.batchId}; grade ${req.body.grade || "A"}.`, req.body.grade === "Rejected" ? "warning" : "success", record.batchId);
  res.status(201).json(record);
}));

app.get("/api/trace/:batchId", asyncRoute(async (req, res) => {
  const record = await Produce.findOne({ batchId: String(req.params.batchId).trim().toUpperCase() }).lean();
  if (!record) return res.status(404).json({ message: "No batch found for that tracking ID." });
  res.json({
    batchId: record.batchId, productName: record.productName, variety: record.variety, farmerName: record.farmerName,
    farmLocation: record.farmLocation, harvestDate: record.harvestDate, expiryDate: record.expiryDate,
    quantityKg: record.quantityKg, availableKg: record.availableKg ?? record.quantityKg, pricePerKg: record.pricePerKg,
    status: record.status, destination: record.destination, latitude: record.latitude, longitude: record.longitude,
    events: record.events, qualityChecks: record.qualityChecks
  });
}));
app.get("/api/produce/:id/qr", requireAuth, asyncRoute(async (req, res) => {
  const record = await Produce.findById(req.params.id);
  if (!record) return res.status(404).json({ message: "Batch not found." });
  const url = `${req.protocol}://${req.get("host")}/?track=${encodeURIComponent(record.batchId)}`;
  res.json({ batchId: record.batchId, url, dataUrl: await QRCode.toDataURL(url, { width: 320, margin: 2 }) });
}));

app.get("/api/analytics", requireAuth, asyncRoute(async (req, res) => {
  const batches = await Produce.find().lean();
  const totalKg = batches.reduce((s, b) => s + Number(b.quantityKg || 0), 0);
  const availableKg = batches.reduce((s, b) => s + Number(b.availableKg ?? b.quantityKg ?? 0), 0);
  const wastageKg = batches.reduce((s, b) => s + Number(b.wastageKg || 0), 0);
  const totalValue = batches.reduce((s, b) => s + Number(b.quantityKg || 0) * Number(b.pricePerKg || 0), 0);
  const byStatus = {};
  const byProduct = {};
  for (const b of batches) {
    byStatus[b.status] = (byStatus[b.status] || 0) + 1;
    byProduct[b.productName] = (byProduct[b.productName] || 0) + Number(b.quantityKg || 0);
  }
  const prices = batches.map(b => ({ batchId: b.batchId, productName: b.productName, pricePerKg: b.pricePerKg, createdAt: b.createdAt }));
  res.json({ totalBatches: batches.length, totalKg, availableKg, wastageKg, totalValue, byStatus, byProduct, prices });
}));
app.get("/api/notifications", requireAuth, asyncRoute(async (req, res) => {
  res.json(await Notification.find().sort({ createdAt: -1 }).limit(40).lean());
}));
app.patch("/api/notifications/read-all", requireAuth, asyncRoute(async (req, res) => {
  await Notification.updateMany({ read: false }, { $set: { read: true } });
  res.json({ ok: true });
}));

app.get("/api/payments", requireAuth, asyncRoute(async (req, res) => {
  res.json(await Payment.find().sort({ createdAt: -1 }).lean());
}));
app.post("/api/payments", requireAuth, allowRoles("Admin", "Farmer", "Distributor", "Retailer"), asyncRoute(async (req, res) => {
  const body = { ...req.body, invoiceNo: String(req.body.invoiceNo || `INV-${Date.now()}`).trim().toUpperCase() };
  const payment = await Payment.create(body);
  await notify(`Invoice ${payment.invoiceNo} created for ₹${payment.amount}.`, "info");
  res.status(201).json(payment);
}));
app.patch("/api/payments/:id", requireAuth, allowRoles("Admin", "Farmer", "Distributor", "Retailer"), asyncRoute(async (req, res) => {
  const update = {};
  for (const key of ["status", "method", "notes", "dueDate"]) if (req.body[key] !== undefined) update[key] = req.body[key];
  if (req.body.status === "Paid") update.paidAt = new Date();
  const payment = await Payment.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
  if (!payment) return res.status(404).json({ message: "Invoice not found." });
  await notify(`Invoice ${payment.invoiceNo} status changed to ${payment.status}.`, "success");
  res.json(payment);
}));

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ message: cleanError(err) });
});

mongoose.connect(MONGO_URI).then(async () => {
  console.log("✓ Connected to MongoDB");
  app.listen(PORT, "0.0.0.0", () => console.log(`✓ AgriTrace running at http://localhost:${PORT}`));
}).catch(err => {
  console.error("MongoDB connection failed:", err.message);
  console.error("Check that MongoDB Server is running.");
  process.exit(1);
});
