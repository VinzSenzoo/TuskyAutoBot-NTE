import blessed from "blessed";
import chalk from "chalk";
import figlet from "figlet";
import { SuiClient, getFullnodeUrl } from "@mysten/sui.js/client";
import { Ed25519Keypair } from "@mysten/sui.js/keypairs/ed25519";
import fs from "fs";
import axios from "axios";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";

const API_BASE_URL = "https://dev-api.tusky.io";
const CONFIG_FILE = "config.json";
const SEED_FILE = "seed.txt";

let walletInfo = {
  address: "N/A",
  activeAccount: "N/A",
  cycleCount: 0,
  nextCycle: "N/A"
};
let transactionLogs = [];
let activityRunning = false;
let isCycleRunning = false;
let shouldStop = false;
let keypairs = [];
let proxies = [];
let selectedWalletIndex = 0;
let loadingSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const borderBlinkColors = ["cyan", "blue", "magenta", "red", "yellow", "green"];
let borderBlinkIndex = 0;
let blinkCounter = 0;
let spinnerIndex = 0;
let isHeaderRendered = false;
let activeProcesses = 0;
let accountTokens = {};
let uploadConfig = { uploadCount: 3 };
let cycleTimeout = null;

const photoAdjectives = [
  "sunset", "ocean", "mountain", "forest", "sky", "river", "cloud", "dawn", "twilight", "horizon",
  "serene", "vibrant", "misty", "golden", "crimson", "azure", "emerald", "sapphire", "radiant", "tranquil"
];
const photoNouns = [
  "moment", "view", "breeze", "scape", "light", "vibe", "dream", "path", "glow", "wave",
  "scene", "horizon", "peak", "valley", "shore", "canopy", "mist", "dusk", "dawn", "twilight"
];
const photoVerbs = [
  "capture", "reflect", "illuminate", "glisten", "shine", "glow", "sparkle", "drift", "flow", "rise",
  "set", "dance", "whisper", "embrace", "bathe", "kiss", "caress", "paint", "etch", "frame"
];

function getRandomString(length = 5) {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

function getFilename() {
  const adjective = photoAdjectives[Math.floor(Math.random() * photoAdjectives.length)];
  const noun = photoNouns[Math.floor(Math.random() * photoNouns.length)];
  const verb = photoVerbs[Math.floor(Math.random() * photoVerbs.length)];
  const randomString = getRandomString();
  return `${adjective}_${noun}_${verb}_${randomString}.jpg`;
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8");
      const config = JSON.parse(data);
      uploadConfig = { ...uploadConfig, ...config.uploadConfig };
      addLog("Loaded config file.", "success");
    } else {
      addLog("No config file found, using default settings.", "info");
    }
  } catch (error) {
    addLog(`Failed to load config: ${error.message}`, "error");
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ uploadConfig }, null, 2));
    addLog("Configuration saved successfully.", "success");
  } catch (error) {
    addLog(`Failed to save config: ${error.message}`, "error");
  }
}

process.on("unhandledRejection", (reason, promise) => {
  addLog(`Unhandled Rejection at: ${promise}, reason: ${reason}`, "error");
});

process.on("uncaughtException", (error) => {
  addLog(`Uncaught Exception: ${error.message}`, "error");
  process.exit(1);
});

function getShortAddress(address) {
  return address ? address.slice(0, 6) + "..." + address.slice(-4) : "N/A";
}

function getShortId(id) {
  return id ? id.slice(0, 8) + "..." : "N/A";
}

function addLog(message, type = "info") {
  const timestamp = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
  let coloredMessage;
  switch (type) {
    case "error":
      coloredMessage = chalk.redBright(message);
      break;
    case "success":
      coloredMessage = chalk.greenBright(message);
      break;
    case "wait":
      coloredMessage = chalk.yellowBright(message);
      break;
    case "info":
      coloredMessage = chalk.whiteBright(message);
      break;
    case "delay":
      coloredMessage = chalk.cyanBright(message);
      break;
    default:
      coloredMessage = chalk.white(message);
  }
  const logMessage = `[${timestamp}] ${coloredMessage}`;
  transactionLogs.push(logMessage);
  if (transactionLogs.length > 100) {
    transactionLogs.shift();
  }
  updateLogs();
}

function clearTransactionLogs() {
  transactionLogs = [];
  logBox.setContent('');
  logBox.scrollTo(0);
  addLog("Transaction logs cleared.", "success");
}

async function sleep(ms) {
  if (shouldStop) {
    return;
  }
  activeProcesses++;
  try {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve();
      }, ms);
      const checkStop = setInterval(() => {
        if (shouldStop) {
          clearTimeout(timeout);
          clearInterval(checkStop);
          resolve();
        }
      }, 100);
    });
  } finally {
    activeProcesses = Math.max(0, activeProcesses - 1);
  }
}

function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function loadSeedPhrases() {
  try {
    const data = fs.readFileSync(SEED_FILE, "utf8");
    const seeds = data.split("\n").map(seed => seed.trim()).filter(seed => seed.split(" ").length >= 12);
    keypairs = seeds.map(seed => {
      try {
        return Ed25519Keypair.deriveKeypair(seed);
      } catch (error) {
        addLog(`Invalid seed phrase: ${seed.slice(0, 10)}...`, "error");
        return null;
      }
    }).filter(kp => kp !== null);
    if (keypairs.length === 0) throw new Error("No valid seed phrases in seed.txt");
    addLog(`Loaded ${keypairs.length} seed phrases from seed.txt`, "success");
  } catch (error) {
    addLog(`Failed to load seed phrases: ${error.message}`, "error");
    keypairs = [];
  }
}

function loadProxies() {
  try {
    const data = fs.readFileSync("proxy.txt", "utf8");
    proxies = data.split("\n").map(proxy => proxy.trim()).filter(proxy => proxy);
    if (proxies.length === 0) throw new Error("No proxies found in proxy.txt");
    addLog(`Loaded ${proxies.length} proxies from proxy.txt`, "success");
  } catch (error) {
    addLog(`No proxy.txt found or failed to load, running without proxies: ${error.message}`, "warn");
    proxies = [];
  }
}

function createAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith("socks")) {
    return new SocksProxyAgent(proxyUrl);
  } else if (proxyUrl.startsWith("http") || proxyUrl.startsWith("https")) {
    return new HttpsProxyAgent(proxyUrl);
  }
  throw new Error(`Unsupported proxy protocol: ${proxyUrl}`);
}

async function getClientWithProxy(proxyUrl) {
  try {
    const agent = createAgent(proxyUrl);
    const client = new SuiClient({
      url: RPC_URL,
      transport: agent ? { agent } : undefined
    });
    await client.getChainIdentifier();
    return client;
  } catch (error) {
    addLog(`Failed to initialize client with proxy: ${error.message}`, "error");
    return new SuiClient({ url: RPC_URL });
  }
}

function getHeaders(token = null) {
  const headers = {
    "accept": "application/json, text/plain, */*",
    "accept-encoding": "gzip, deflate, br",
    "accept-language": "en-US,en;q=0.9,id;q=0.8",
    "client-name": "Tusky-App/dev",
    "content-type": "application/json",
    "origin": "https://testnet.app.tusky.io",
    "priority": "u=1, i",
    "referer": "https://testnet.app.tusky.io/",
    "sdk-version": "Tusky-SDK/0.31.0",
    "sec-ch-ua": '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
  };
  if (token) {
    headers["authorization"] = `Bearer ${token}`;
  }
  return headers;
}

async function makeApiRequest(method, url, data, proxyUrl, customHeaders = {}, maxRetries = 3, retryDelay = 2000) {
  activeProcesses++;
  try {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const agent = createAgent(proxyUrl);
        const headers = { ...customHeaders };
        const config = {
          method,
          url,
          data,
          headers,
          ...(agent ? { httpsAgent: agent, httpAgent: agent } : {}),
          timeout: 10000
        };
        const response = await axios(config);
        return response.data;
      } catch (error) {
        let errorMessage = `Attempt ${attempt}/${maxRetries} failed for API request to ${url}`;
        if (error.response) errorMessage += `: HTTP ${error.response.status} - ${JSON.stringify(error.response.data || error.response.statusText)}`;
        else if (error.request) errorMessage += `: No response received`;
        else errorMessage += `: ${error.message}`;
        addLog(errorMessage, "error");
        if (attempt < maxRetries) {
          addLog(`Retrying API request in ${retryDelay/1000} seconds...`, "wait");
          await sleep(retryDelay);
        }
      }
    }
    throw new Error(`Failed to make API request to ${url} after ${maxRetries} attempts`);
  } finally {
    activeProcesses = Math.max(0, activeProcesses - 1);
  }
}

async function listFilesInVault(vaultId, parentId, proxyUrl, token) {
  try {
    const filesUrl = `${API_BASE_URL}/files?vaultId=${vaultId}&parentId=${parentId}&limit=80`;
    const response = await makeApiRequest("get", filesUrl, null, proxyUrl, getHeaders(token));
    return response.items || [];
  } catch (error) {
    addLog(`Failed to list files in vault ${getShortId(vaultId)}: ${error.message}`, "error");
    return [];
  }
}

async function getFolderId(vaultId, proxyUrl, token) {
  try {
    const foldersUrl = `${API_BASE_URL}/folders?vaultId=${vaultId}&parentId=${vaultId}&limit=80`;
    const response = await makeApiRequest("get", foldersUrl, null, proxyUrl, getHeaders(token));
    if (response.items && response.items.length > 0) {
      return response.items[0].id;
    }
    return vaultId;
  } catch (error) {
    addLog(`Failed to fetch folders for vault ${getShortId(vaultId)}: ${error.message}`, "error");
    return vaultId;
  }
}

function generateUploadMetadata(vaultId, parentId, filename, fileType, imageSize) {
  const metadata = {
    vaultId: Buffer.from(vaultId).toString("base64"),
    parentId: Buffer.from(parentId).toString("base64"),
    name: filename,
    type: Buffer.from(fileType).toString("base64"),
    filetype: Buffer.from(fileType).toString("base64"),
    filename: Buffer.from(filename).toString("base64"),
    numberOfChunks: Buffer.from("1").toString("base64"),
    chunkSize: Buffer.from(imageSize.toString()).toString("base64")
  };
  return Object.entries(metadata).map(([key, value]) => `${key} ${value}`).join(",");
}

async function updateWalletData() {
  const walletDataPromises = keypairs.map(async (keypair, i) => {
    try {
      const address = keypair.getPublicKey().toSuiAddress();
      const formattedEntry = `${i === selectedWalletIndex ? "→ " : "  "}${getShortAddress(address)}`;
      if (i === selectedWalletIndex) {
        walletInfo.address = address;
        walletInfo.activeAccount = getShortAddress(address);
      }
      return formattedEntry;
    } catch (error) {
      addLog(`Failed to fetch wallet data for account #${i + 1}: ${error.message}`, "error");
      return `${i === selectedWalletIndex ? "→ " : "  "}N/A`;
    }
  });
  const walletData = await Promise.all(walletDataPromises);
  addLog("Wallet data updated.", "success");
  return walletData;
}

async function loginAccount(keypair, proxyUrl) {
  if (shouldStop) {
    return false;
  }
  try {
    const address = keypair.getPublicKey().toSuiAddress();
    const challengeUrl = `${API_BASE_URL}/auth/create-challenge`;
    const challengePayload = { address: address };
    const challengeResponse = await makeApiRequest("post", challengeUrl, challengePayload, proxyUrl, getHeaders());
    
    if (!challengeResponse || !challengeResponse.nonce) {
      throw new Error("Invalid challenge response: No nonce received");
    }
    const nonce = challengeResponse.nonce;
    
    const message = `tusky:connect:${nonce}`;
    const messageBytes = new TextEncoder().encode(message);
    const signatureObj = await keypair.signPersonalMessage(messageBytes);
    const signature = signatureObj.signature;
    
    const verifyUrl = `${API_BASE_URL}/auth/verify-challenge`;
    const verifyPayload = {
      address: address,
      signature: signature
    };
    const verifyResponse = await makeApiRequest("post", verifyUrl, verifyPayload, proxyUrl, getHeaders());
    if (!verifyResponse.idToken) {
      throw new Error("No idToken received in verify response");
    }
    const idToken = verifyResponse.idToken;
    accountTokens[address] = idToken;
    addLog(`Account ${getShortAddress(address)}: Logged in successfully.`, "success");
    return true;
  } catch (error) {
    addLog(`Account ${getShortAddress(keypair.getPublicKey().toSuiAddress())}: Login error: ${error.message}`, "error");
    return false;
  }
}

async function generateRandomImage() {
  const randomSeed = Math.floor(Math.random() * 100000);
  const imageUrl = `https://picsum.photos/seed/${randomSeed}/500/500`;
  const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
  return imageResponse.data;
}

async function autoUpload() {
  if (keypairs.length === 0) {
    addLog("No valid seed phrases found.", "error");
    return;
  }
  addLog(`Starting Auto Upload for ${keypairs.length} accounts with ${uploadConfig.uploadCount} uploads each.`, "info");
  activityRunning = true;
  isCycleRunning = true;
  shouldStop = false;
  activeProcesses = 0;
  updateMenu();
  try {
    for (let accountIndex = 0; accountIndex < keypairs.length && !shouldStop; accountIndex++) {
      selectedWalletIndex = accountIndex;
      const proxyUrl = proxies[accountIndex % proxies.length] || null;
      const proxyInfo = proxyUrl ? `using proxy ${proxyUrl}` : "no proxy";
      const keypair = keypairs[accountIndex];
      const address = keypair.getPublicKey().toSuiAddress();
      addLog(`Processing account ${accountIndex + 1}: ${getShortAddress(address)} (${proxyInfo}).`, "info");
      await updateWallets();

      const loginSuccess = await loginAccount(keypair, proxyUrl);
      if (!loginSuccess) {
        addLog(`Account ${accountIndex + 1}: Skipping upload due to login failure.`, "error");
        continue;
      }

      let usedVaultIds = [];
      for (let i = 0; i < uploadConfig.uploadCount && !shouldStop; i++) {
        try {
          const vaultsUrl = `${API_BASE_URL}/vaults?status=active&limit=1000`;
          const vaultsResponse = await makeApiRequest("get", vaultsUrl, null, proxyUrl, getHeaders(accountTokens[address]));
          const vaults = vaultsResponse.items.filter(vault => vault.encrypted === false);
          if (!vaults || vaults.length === 0) {
            addLog(`Account ${accountIndex + 1}: No unencrypted vaults available.`, "error");
            break;
          }
          addLog(`Account ${accountIndex + 1}: Found ${vaults.length} unencrypted vaults.`, "info");

          let availableVaults = vaults.filter(vault => !usedVaultIds.includes(vault.id));
          if (availableVaults.length === 0) {
            usedVaultIds = [];
            availableVaults = vaults;
          }

          const randomVault = availableVaults[Math.floor(Math.random() * availableVaults.length)];
          const vaultId = randomVault.id;
          const vaultName = randomVault.name || getShortId(vaultId);
          usedVaultIds.push(vaultId);
          const parentId = await getFolderId(vaultId, proxyUrl, accountTokens[address]);
          addLog(`Account ${accountIndex + 1}: Selected Vault ${vaultName} For image ${i + 1}.`, "info");

          const imageBuffer = await generateRandomImage();
          const filename = getFilename();
          const fileType = "image/jpeg";

          const uploadUrl = `${API_BASE_URL}/uploads`;
          const uploadMetadata = generateUploadMetadata(vaultId, parentId, filename, fileType, imageBuffer.length);
          const uploadHeaders = {
            ...getHeaders(accountTokens[address]),
            "content-type": "application/offset+octet-stream",
            "tus-resumable": "1.0.0",
            "upload-length": imageBuffer.length.toString(),
            "upload-metadata": uploadMetadata,
            "accept": "*/*",
            "content-length": imageBuffer.length.toString()
          };
          const uploadResponse = await makeApiRequest("post", uploadUrl, imageBuffer, proxyUrl, uploadHeaders);
          if (uploadResponse.uploadId) {
            addLog(`Account ${accountIndex + 1}: Image ${i + 1} uploaded successfully. ID: ${getShortId(uploadResponse.uploadId)}`, "success");
            await sleep(2000);
            const files = await listFilesInVault(vaultId, parentId, proxyUrl, accountTokens[address]);
            if (files.some(file => file.name === filename)) {
              addLog(`Account ${accountIndex + 1}: Image ${i + 1} confirmed in vault ${vaultName} with name ${filename}`, "success");
            } else {
              addLog(`Account ${accountIndex + 1}: Image ${i + 1} not found in vault ${vaultName}.`, "error");
            }
          } else {
            addLog(`Account ${accountIndex + 1}: Image ${i + 1} upload failed. No uploadId received.`, "error");
          }

          if (i < uploadConfig.uploadCount - 1 && !shouldStop) {
            const delay = getRandomDelay(4000, 10000);
            addLog(`Account ${accountIndex + 1}: Waiting ${(delay/1000).toFixed(2)} seconds before next upload...`, "delay");
            await sleep(delay);
          }
        } catch (error) {
          addLog(`Account ${accountIndex + 1}: Image ${i + 1} upload error: ${error.message}`, "error");
        }
      }

      if (accountIndex < keypairs.length - 1 && !shouldStop) {
        addLog(`Waiting 5 seconds before next account...`, "delay");
        await sleep(5000);
      }
    }
    if (!shouldStop && activeProcesses <= 0) {
      addLog("All accounts processed. Waiting 24 hours for next cycle.", "success");
      cycleTimeout = setTimeout(autoUpload, 24 * 60 * 60 * 1000);
      activityRunning = false;
      isCycleRunning = true;
      updateStatus();
      safeRender();
    }
  } catch (error) {
    addLog(`Auto upload failed: ${error.message}`, "error");
    activityRunning = false;
    isCycleRunning = false;
    shouldStop = false;
    if (cycleTimeout) {
      clearTimeout(cycleTimeout);
      cycleTimeout = null;
    }
    updateMenu();
    updateStatus();
    safeRender();
  } finally {
    if (shouldStop && activeProcesses <= 0) {
      activityRunning = false;
      isCycleRunning = false;
      shouldStop = false;
      if (cycleTimeout) {
        clearTimeout(cycleTimeout);
        cycleTimeout = null;
      }
      addLog("Auto upload stopped successfully.", "success");
      updateMenu();
      updateStatus();
      safeRender();
    }
  }
}

const screen = blessed.screen({
  smartCSR: true,
  title: "TUSKY AUTO UPLOAD BOT",
  autoPadding: true,
  fullUnicode: true,
  mouse: true,
  ignoreLocked: ["C-c", "q", "escape"]
});

const headerBox = blessed.box({
  top: 0,
  left: "center",
  width: "100%",
  height: 6,
  tags: true,
  style: { fg: "yellow", bg: "default" }
});

const statusBox = blessed.box({
  left: 0,
  top: 6,
  width: "100%",
  height: 3,
  tags: true,
  border: { type: "line", fg: "cyan" },
  style: { fg: "white", bg: "default", border: { fg: "cyan" } },
  content: "Status: Initializing...",
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  label: chalk.cyan(" Status "),
  wrap: true
});

const walletBox = blessed.list({
  label: " Wallet Information",
  top: 9,
  left: 0,
  width: "40%",
  height: "35%",
  border: { type: "line", fg: "cyan" },
  style: { border: { fg: "cyan" }, fg: "white", bg: "default", item: { fg: "white" } },
  scrollable: true,
  scrollbar: { bg: "cyan", fg: "black" },
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  tags: true,
  keys: true,
  vi: true,
  mouse: true,
  content: "Loading wallet data..."
});

const logBox = blessed.log({
  label: " Transaction Logs",
  top: 9,
  left: "41%",
  width: "60%",
  height: "100%-9",
  border: { type: "line" },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  tags: true,
  scrollbar: { ch: "│", style: { bg: "cyan", fg: "white" }, track: { bg: "gray" } },
  scrollback: 100,
  smoothScroll: true,
  style: { border: { fg: "magenta" }, bg: "default", fg: "white" },
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  wrap: true,
  focusable: true,
  keys: true
});

const menuBox = blessed.list({
  label: " Menu ",
  top: "44%",
  left: 0,
  width: "40%",
  height: "56%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "magenta", fg: "black" }, item: { fg: "white" } },
  items: ["Start Auto Upload", "Set Manual Config", "Clear Logs", "Refresh", "Exit"],
  padding: { left: 1, top: 1 }
});

const uploadConfigSubMenu = blessed.list({
  label: " Manual Config Options ",
  top: "44%",
  left: 0,
  width: "40%",
  height: "56%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" },
    selected: { bg: "blue", fg: "black" },
    item: { fg: "white" }
  },
  items: ["Set Upload Count", "Back to Main Menu"],
  padding: { left: 1, top: 1 },
  hidden: true
});

const configForm = blessed.form({
  label: " Enter Config Value ",
  top: "center",
  left: "center",
  width: "30%",
  height: "40%",
  keys: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" }
  },
  padding: { left: 1, top: 1 },
  hidden: true
});

const configLabel = blessed.text({
  parent: configForm,
  top: 0,
  left: 1,
  content: "Upload Count (1-10):",
  style: { fg: "white" }
});

const configInput = blessed.textbox({
  parent: configForm,
  top: 1,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const configSubmitButton = blessed.button({
  parent: configForm,
  top: 5,
  left: "center",
  width: 10,
  height: 3,
  content: "Submit",
  align: "center",
  border: { type: "line" },
  clickable: true,
  keys: true,
  style: {
    fg: "white",
    bg: "blue",
    border: { fg: "white" },
    hover: { bg: "green" },
    focus: { bg: "green", border: { fg: "yellow" } }
  }
});

screen.append(headerBox);
screen.append(statusBox);
screen.append(walletBox);
screen.append(logBox);
screen.append(menuBox);
screen.append(uploadConfigSubMenu);
screen.append(configForm);

let renderQueue = [];
let isRendering = false;
function safeRender() {
  renderQueue.push(true);
  if (isRendering) return;
  isRendering = true;
  setTimeout(() => {
    try {
      if (!isHeaderRendered) {
        figlet.text("NT EXHAUST", { font: "ANSI Shadow" }, (err, data) => {
          if (!err) headerBox.setContent(`{center}{bold}{cyan-fg}${data}{/cyan-fg}{/bold}{/center}`);
          isHeaderRendered = true;
        });
      }
      screen.render();
    } catch (error) {
      addLog(`UI render error: ${error.message}`, "error");
    }
    renderQueue.shift();
    isRendering = false;
    if (renderQueue.length > 0) safeRender();
  }, 100);
}

function adjustLayout() {
  const screenHeight = screen.height || 24;
  const screenWidth = screen.width || 80;

  headerBox.height = Math.max(6, Math.floor(screenHeight * 0.15));
  statusBox.top = headerBox.height;
  statusBox.height = Math.max(3, Math.floor(screenHeight * 0.07));

  walletBox.top = headerBox.height + statusBox.height;
  walletBox.width = Math.floor(screenWidth * 0.4);
  walletBox.height = Math.floor(screenHeight * 0.35);

  logBox.top = headerBox.height + statusBox.height;
  logBox.left = Math.floor(screenWidth * 0.41);
  logBox.width = Math.floor(screenWidth * 0.6);
  logBox.height = screenHeight - (headerBox.height + statusBox.height);

  menuBox.top = headerBox.height + statusBox.height + walletBox.height;
  menuBox.width = Math.floor(screenWidth * 0.4);
  menuBox.height = screenHeight - (headerBox.height + statusBox.height + walletBox.height);

  uploadConfigSubMenu.top = menuBox.top;
  uploadConfigSubMenu.width = menuBox.width;
  uploadConfigSubMenu.height = menuBox.height;
  uploadConfigSubMenu.left = menuBox.left;
  configForm.width = Math.floor(screenWidth * 0.3);
  configForm.height = Math.floor(screenHeight * 0.4);

  safeRender();
}

function updateStatus() {
  const isProcessing = activityRunning || isCycleRunning;
  const status = activityRunning
    ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Running")}`
    : isCycleRunning
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Waiting for next cycle")}`
      : chalk.green("Idle");
  const statusText = `Status: ${status} | Active Account: ${walletInfo.activeAccount} | Total Accounts: ${keypairs.length} | Uploads per Account: ${uploadConfig.uploadCount}`;
  try {
    statusBox.setContent(statusText);
  } catch (error) {
    addLog(`Status update error: ${error.message}`, "error");
  }
  if (isProcessing) {
    if (blinkCounter % 1 === 0) {
      statusBox.style.border.fg = borderBlinkColors[borderBlinkIndex];
      borderBlinkIndex = (borderBlinkIndex + 1) % borderBlinkColors.length;
    }
    blinkCounter++;
  } else {
    statusBox.style.border.fg = "cyan";
  }
  spinnerIndex = (spinnerIndex + 1) % loadingSpinner.length;
  safeRender();
}

async function updateWallets() {
  const walletData = await updateWalletData();
  const header = `${chalk.bold.cyan("Address")}`;
  const separator = chalk.gray("-".repeat(30));
  try {
    walletBox.setItems([header, separator, ...walletData]);
    walletBox.select(2 + selectedWalletIndex);
  } catch (error) {
    addLog(`Wallet update error: ${error.message}`, "error");
  }
  safeRender();
}

function updateLogs() {
  try {
    logBox.add(transactionLogs[transactionLogs.length - 1] || chalk.gray("No logs available."));
    safeRender();
  } catch (error) {
    addLog(`Log update failed: ${error.message}`, "error");
  }
}

function updateMenu() {
  const menuItems = isCycleRunning
    ? ["Stop Auto Upload", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
    : ["Start Auto Upload", "Set Manual Config", "Clear Logs", "Refresh", "Exit"];
  try {
    menuBox.setItems(menuItems);
    menuBox.select(0);
  } catch (error) {
    addLog(`Menu update error: ${error.message}`, "error");
  }
  safeRender();
}

logBox.key(["up"], () => {
  if (screen.focused === logBox) {
    logBox.scroll(-1);
    safeRender();
  }
});

logBox.key(["down"], () => {
  if (screen.focused === logBox) {
    logBox.scroll(1);
    safeRender();
  }
});

logBox.on("click", () => {
  screen.focusPush(logBox);
  logBox.style.border.fg = "yellow";
  menuBox.style.border.fg = "red";
  uploadConfigSubMenu.style.border.fg = "blue";
  safeRender();
});

logBox.on("blur", () => {
  logBox.style.border.fg = "magenta";
  safeRender();
});

menuBox.on("select", async item => {
  const action = item.getText();
  switch (action) {
    case "Start Auto Upload":
      if (isCycleRunning) {
        addLog("Cycle is still running. Stop the current cycle first.", "error");
      } else {
        await autoUpload();
      }
      break;
    case "Stop Auto Upload":
      shouldStop = true;
      addLog("Stopping auto upload... Please wait for ongoing processes to complete.", "info");
      if (cycleTimeout) {
        clearTimeout(cycleTimeout);
        cycleTimeout = null;
        activityRunning = false;
        isCycleRunning = false;
        shouldStop = false;
        addLog("Auto upload stopped successfully.", "success");
        updateMenu();
        updateStatus();
        safeRender();
      }
      break;
    case "Set Manual Config":
      menuBox.hide();
      uploadConfigSubMenu.show();
      setTimeout(() => {
        if (uploadConfigSubMenu.visible) {
          screen.focusPush(uploadConfigSubMenu);
          uploadConfigSubMenu.style.border.fg = "yellow";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;
    case "Clear Logs":
      clearTransactionLogs();
      break;
    case "Refresh":
      await updateWallets();
      addLog("Data refreshed.", "success");
      break;
    case "Exit":
      clearInterval(statusInterval);
      if (cycleTimeout) {
        clearTimeout(cycleTimeout);
        cycleTimeout = null;
      }
      process.exit(0);
  }
  safeRender();
});

uploadConfigSubMenu.on("select", (item) => {
  const action = item.getText();
  switch (action) {
    case "Set Upload Count":
      configForm.configType = "uploadCount";
      configForm.setLabel(" Enter Upload Count ");
      configLabel.setContent("Upload Count (1-100):");
      configInput.setValue(uploadConfig.uploadCount.toString());
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          safeRender();
        }
      }, 100);
      break;
    case "Back to Main Menu":
      uploadConfigSubMenu.hide();
      menuBox.show();
      setTimeout(() => {
        if (menuBox.visible) {
          screen.focusPush(menuBox);
          menuBox.style.border.fg = "cyan";
          uploadConfigSubMenu.style.border.fg = "blue";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;
  }
});

configForm.on("submit", () => {
  const inputValue = configInput.getValue().trim();
  let value;
  try {
    value = parseInt(inputValue, 10);
    if (isNaN(value) || value < 1 || value > 100) {
      addLog("Invalid upload count. Please enter a number between 1 and 100.", "error");
      configInput.setValue("");
      screen.focusPush(configInput);
      safeRender();
      return;
    }
  } catch (error) {
    addLog(`Invalid format: ${error.message}`, "error");
    configInput.setValue("");
    screen.focusPush(configInput);
    safeRender();
    return;
  }

  if (configForm.configType === "uploadCount") {
    uploadConfig.uploadCount = value;
    addLog(`Upload Count set to ${uploadConfig.uploadCount}`, "success");
    saveConfig();
    updateStatus();
  }

  configForm.hide();
  uploadConfigSubMenu.show();
  setTimeout(() => {
    if (uploadConfigSubMenu.visible) {
      screen.focusPush(uploadConfigSubMenu);
      uploadConfigSubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

configInput.on("submit", () => {
  configForm.submit();
});

configSubmitButton.on("press", () => {
  configForm.submit();
});

configSubmitButton.on("click", () => {
  configForm.submit();
});

configForm.key(["escape"], () => {
  configForm.hide();
  uploadConfigSubMenu.show();
  setTimeout(() => {
    if (uploadConfigSubMenu.visible) {
      screen.focusPush(uploadConfigSubMenu);
      uploadConfigSubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

uploadConfigSubMenu.key(["escape"], () => {
  uploadConfigSubMenu.hide();
  menuBox.show();
  setTimeout(() => {
    if (menuBox.visible) {
      screen.focusPush(menuBox);
      menuBox.style.border.fg = "cyan";
      uploadConfigSubMenu.style.border.fg = "blue";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

const statusInterval = setInterval(() => {
  updateStatus();
  safeRender();
}, 100);

screen.key(["escape", "q", "C-c"], () => {
  addLog("Exiting application", "info");
  clearInterval(statusInterval);
  if (cycleTimeout) {
    clearTimeout(cycleTimeout);
    cycleTimeout = null;
  }
  process.exit(0);
});

async function initialize() {
  loadConfig();
  loadSeedPhrases();
  loadProxies();
  await updateWallets();
  updateStatus();
  updateLogs();
  updateMenu();
  adjustLayout();
  setTimeout(() => {
    menuBox.show();
    menuBox.focus();
    menuBox.select(0);
    screen.render();
  }, 100);
  safeRender();
}

setTimeout(() => {
  adjustLayout();
  screen.on("resize", adjustLayout);
}, 100);

initialize();