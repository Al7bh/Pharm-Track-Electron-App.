# Nouman Pharmacy Project Summary

## What this project does

This project is an Electron-based pharmacy POS system for managing inventory, processing sales, handling returns, viewing sales history, and managing owner-level settings. It is designed to run either as:

- a standalone server machine, or
- a client machine connected to a main server.

The app uses:

- Electron for the desktop app shell
- React for the frontend UI
- SQLite for the local database
- Express for the server API (server mode)
- IPC for local communication in server mode
- HTTP requests for client-to-server communication in client mode

---

## Main features currently implemented

### 1. Sales counter
- Lets the cashier add products to a cart
- Supports barcode-based product lookup
- Calculates subtotal, discounts, and final total
- Processes checkout and updates stock automatically
- Saves the sale into sales history

### 2. Inventory management
- Add new products
- Edit existing products
- Search products by name, generic name, batch, or barcode
- Soft-delete products so they are not shown in active inventory
- Track quantity, price, category, batch, expiry, and factor

### 3. Sales history and returns
- View previous sales
- Search sales by invoice number or sale reference
- Process returns for sold items
- Restock inventory when items are returned
- Create return entries in history

### 4. Owner / admin controls
- Change terminal username
- Change terminal password
- Change vault PIN
- View owner earnings / vault-related actions
- Export database backup
- Import database backup
- Configure system mode and server connection settings

### 5. Developer / system configuration
- Choose whether the machine is a server or a client
- Set the server IP and port
- Test server connection
- Set a developer password
- Restart the app after settings change

---

## What happens when the app starts

On startup, the app does the following:

1. Reads a local configuration file named system-config.json
2. Decides whether the machine is a server or a client
3. If it is a server:
   - opens the SQLite database
   - creates required tables if missing
   - seeds default credentials if necessary
   - starts an Express API server
4. Opens the main Electron window and loads the frontend UI

---

## Server mode vs client mode

### Server mode
The server machine is the main system that owns the real database.

It does the following:
- Stores the actual inventory and sales data
- Handles authentication locally
- Runs the Express API server
- Processes checkout and return transactions
- Prints receipts on the server machine
- Creates backups and restores data

### Client mode
A client machine does not open the main database directly.

Instead, it:
- connects to the server over HTTP
- sends requests to the server API
- uses the server database as the source of truth
- shows the same UI but works through network calls

This means the client machine is lighter and does not own the data itself.

---

## How the app handles data safely

The app includes several protections so it does not crash easily during common problems.

### 1. Crash protection at the app level
The main process has global handlers for:
- uncaught exceptions
- unhandled promise rejections

If one of these occurs, the app:
- writes a crash log to the user data folder
- shows an error dialog
- quits safely

### 2. Database initialization protection
The app creates tables if they do not exist and uses safe initialization logic.
If the database file is missing, it can seed a fresh copy from a packaged resource or local file.

### 3. Server startup safety
If the API port is already in use, the app detects it and stops with a clear error instead of silently failing.

### 4. Transaction safety for checkout and returns
Checkout and returns use database transactions.
That means:
- changes are grouped together
- if one step fails, the transaction can roll back
- stock updates and sale history remain consistent

### 5. Printing protection
Receipt printing is wrapped in a safe try/catch path.
If printing fails, the app logs the error instead of crashing the full system.

---

## Common scenarios the app covers

### Scenario: normal sale
When a cashier completes a sale:
1. The cart is validated
2. A sale transaction starts
3. The sale is saved to sales history
4. Inventory stock is reduced
5. A receipt is printed
6. The app returns success to the UI

If stock is insufficient, the transaction is rolled back and the sale is rejected.

### Scenario: insufficient stock
If a customer buys more units than available:
- the checkout is blocked
- the database transaction is rolled back
- the app shows an error message like insufficient stock
- no partial sale is saved

### Scenario: return of sold item
When a return is processed:
1. The returned stock is added back to inventory
2. A return record is created
3. The original sale is adjusted or deleted depending on the return type
4. The stock and sales data stay consistent

### Scenario: printer issue
When a receipt print is triggered:
- the app creates a temporary hidden browser window
- it loads the receipt HTML
- it sends the print command
- if something fails, it cleans up and logs the issue

The sale itself is not supposed to be lost because printing is isolated from the main transaction logic.

### Scenario: server disconnected
If a client cannot reach the server:
- it shows an offline or unreachable state
- authentication and data actions fail gracefully with a clear message
- the UI does not crash

### Scenario: wrong credentials
If someone enters the wrong terminal password or vault PIN:
- the app denies access
- the attempt counter increases
- after repeated failures, the session locks for that run to reduce abuse

### Scenario: database backup / restore
The app supports:
- exporting the database to a backup file
- opening the backup location in the file explorer
- sending the backup by email
- importing a backup database file

These actions are protected so they are only available from the server-side admin flow.

### Scenario: app restart after settings change
When the developer saves new config values:
- the config is written to disk
- the app shows a success notification
- it restarts cleanly

---

## What happens during printing

Printing is handled on the server machine.

When a sale is completed:
- the app generates a receipt in HTML
- it creates a temporary hidden Electron window
- the receipt is loaded into that window
- the print command is sent silently
- the temporary window is cleaned up afterward

This design allows the app to print receipts without showing a visible print window to the user.

If the printer fails, the code logs the failure and avoids crashing the whole application.

---

## What happens when you do common actions

### Add inventory item
- The form data is validated
- The item is inserted into the SQLite database
- The inventory list refreshes
- The UI updates without requiring a full app restart

### Edit inventory item
- The selected item is updated in the database
- The UI refreshes to show the latest values

### Search inventory
- A search query is sent to the database or API
- Matching products are returned quickly
- The UI displays the results

### Checkout
- The sale is saved in a transaction
- Stock is deducted
- The receipt is printed
- The sales history is updated

### Return item
- Inventory is restocked
- A return record is saved
- The sale record is adjusted or removed depending on the action

### Open developer settings
- The user must pass a developer password check
- If no password exists yet, access is allowed for first-time setup
- Settings can then be changed safely

---

## Current stability approach

The app is built with a practical safety approach:
- avoid silent failures
- log important errors
- use transactions for stock-sensitive actions
- isolate printing from business logic
- keep server/client roles clearly separated
- fail gracefully when network or device issues happen

This means the app is designed to handle common pharmacy workflow problems without crashing the full desktop application.

---

## Short version

This project is a pharmacy POS system that can:
- manage inventory
- process sales and returns
- track sales history
- support server/client networking
- print receipts
- protect data with transactions and backup tools
- handle many common failure cases without crashing the entire app
