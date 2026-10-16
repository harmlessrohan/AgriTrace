# AgriTrace Upgrade (MongoDB)

## Start
```bash
npm install
npm start
```
Open http://localhost:5000

## Existing data
The app keeps the same MongoDB URI by default (`mongodb://127.0.0.1:27017/agritrace`) and the same Mongoose `Produce` model/`produces` collection. Existing batch documents remain in place; new fields are optional/backfilled by the UI where needed. No database is dropped or reset.

## First login
If the database has no AgriTrace user accounts, the app shows a one-time admin setup form. Create the administrator with a strong password. If user accounts already exist, sign in with an existing account. Admin can add other users and roles.

## Features
- QR generation and public trace page (`/?track=BATCH-ID`)
- Timeline events with locations, timestamps, coordinates, temperatures, and price changes
- Dashboard and Chart.js analytics; CSV export
- Role-based login/session access
- Quality checks, rejected quantity, stock and wastage
- Inventory and expiry tracking
- Shipment map pins using supplied GPS coordinates (not live vehicle GPS)
- Invoices, payment status and print/save-to-PDF
- Status-change notifications

## Notes
- This is a local development app. Express's default in-memory session store is not suitable for production deployment.
- Chart.js, Leaflet, OpenStreetMap tiles, and Google Fonts load from the internet.
- QR URLs use the host you open the app with. For public scanning outside your computer, deploy the app to a reachable HTTPS host first.
- Payments are records only; no payment gateway is integrated.
