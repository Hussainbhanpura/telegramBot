const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');
const cron = require('node-cron');
const axios = require('axios');
const { MongoClient } = require('mongodb');
require('dotenv').config();
const express = require('express');
const app = express();
const { join } = require("path");


// Environment variables
const MONGODB_URI = process.env.MONGODB_URI;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_GROUP_CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID;
const PORT = process.env.PORT || 3000;
const SCRAPE_INTERVAL_MINUTES = process.env.SCRAPE_INTERVAL_MINUTES || 10;

// Create a new Telegram bot instance
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

const PRODUCTS = [
    "iPhone 13 128",
    "iPhone 13 256",
    "iPhone 14 128",
    "iPhone 14 256",
    "iPhone 15 128",
    "iPhone 15 256",
];

const DESIRED_COMPANIES = [
    "Amazon",
    "Flipkart",
    "Vijay Sales",
    "Reliance Digital",
    "Jiomart",
    "Croma",
];

const matchCompanyNames = (name1, name2) => {
    const normalized_name1 = name1.replace(/[^\w\s]/gi, '').toLowerCase().replace('gb', '');
    const normalized_name2 = name2.replace(/[^\w\s]/gi, '').toLowerCase().replace('gb', '');
    return normalized_name1.includes(normalized_name2);
};

// Function to match product names
const matchProductNames = (name1, name2) => {
    // Function to normalize and split the names
    const normalizeAndSplit = (name) => {
        return name
            .replace(/(\s?)\(([^)]*)\)(\s?)/g, '$1$2$3')
            .replace(/[^\w\s]/gi, '')  // Remove special characters
            .toLowerCase()             // Convert to lowercase
            .replace(/\s+/g, ' ')      // Replace multiple spaces with a single space
            .replace(/gb/g, '')
            .trim()                    // Remove leading and trailing spaces
            .split(' ');               // Split into array of words
    };

    const split_name1 = normalizeAndSplit(name1);
    const split_name2 = normalizeAndSplit(name2);
    // Check if every word in split_name2 is present in split_name1
    const allWordsPresent = split_name2.every(word => split_name1.includes(word));

    return allWordsPresent;
};


// Start listening for messages
bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    const userMessage = msg.text;
    // Check if the message is from the correct group
    if (chatId === TELEGRAM_GROUP_CHAT_ID) {
        console.log("in chat");
        const product = PRODUCTS.find(p => matchProductNames(p,userMessage));
        if (product) {
            let client; // Define client variable outside of try block

            try {
                // Connect to MongoDB
                client = await MongoClient.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
                const db = client.db('test');
                const collection = db.collection('iphone_prices');

                // Query the database for the product
                const results = await collection.find({ Product: product }).toArray();

                if (results.length > 0) {
                    let response = `Prices for ${product}:\n`;
                    results.forEach(result => {
                        response += `Company: ${result.Company}\nPrice: ₹${result.Price}\n\n`;
                    });
                    bot.sendMessage(chatId, response);
                } else {
                    bot.sendMessage(chatId, `No data found for ${product}.`);
                }
            } catch (error) {
                console.error('Error querying the database:', error);
                bot.sendMessage(chatId, 'An error occurred while querying the database.');
            } finally {
                if (client) {
                    await client.close(); // Close the client if it was created
                }
            }
        } else {
            bot.sendMessage(chatId, 'Product not recognized. Please send a valid product name.');
        }
    }});

    bot.on('polling_error', (error) => {
        console.error('Polling error:', error);
        bot.stopPolling().then(() => {
          console.log('Polling stopped');
          setTimeout(() => {
            console.log('Restarting polling');
            bot.startPolling();
          }, 10000);  // Wait 10 seconds before restarting
        });
      });

const cacheDirectory = join(__dirname, ".cache", "puppeteer");
// Setup Puppeteer driver
const setupBrowser = async () => {
    return await puppeteer.launch({
        headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process'
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
    });
};

// Scrape Google Shopping
const scrapeGoogleShopping = async (browser, product) => {
    let results = new Set();
    try {
        const page = await browser.newPage();
        await page.goto(`https://www.google.com/search?q=${product.replace(/\s+/g, "+")}`);
        
        // Wait for the shopping tab and click it
        await page.waitForSelector('button[data-name="stores"]', { visible: true, timeout: 10000 });
        await page.click('button[data-name="stores"]');

        // Wait for the shopping results to appear
        await page.waitForSelector('table.AHFItb');
        await new Promise(resolve => setTimeout(resolve, 5000));

        const rows = await page.$$('tr.LvCS6d');
        for (const row of rows) {
            const columns = await row.$$('td.gWeIWe');
            const Company = await columns[0].evaluate(el => el.textContent);
            const Product = await columns[1].evaluate(el => el.textContent);
            const Price = await columns[3].evaluate(el => el.querySelector('span.Pgbknd').textContent.replace("₹", "").replace(",", ""));
            
            if (
                matchProductNames(Product,product) && 
                DESIRED_COMPANIES.some(desiredCompany => matchCompanyNames(Company, desiredCompany))
            ) {
                results.add({ Company, Product, Price });
            }
            
        }
        return results;
    } catch (error) {
        console.log(`Error occurred during scraping: ${error}`);
        return results;
    }
};

// Send Telegram alert
const sendTelegramAlert = async (message) => {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const payload = { chat_id: TELEGRAM_GROUP_CHAT_ID, text: message };

    try {
        const response = await axios.post(url, payload);
        console.log('Telegram alert sent successfully');
    } catch (error) {
        console.log(`Error sending Telegram alert: ${error}`);
    }
};

// Save results to MongoDB
const saveResults = async (results, product) => {
    try {
        const client = await MongoClient.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
        const db = client.db('test');
        const collection = db.collection('iphone_prices');

        for (const result of results) {
            const existingDocument = await collection.findOne({ Company: result.Company, Product: product });

            if (existingDocument) {
                if (existingDocument.Price != result.Price) {
                    await collection.updateOne(
                        { _id: existingDocument._id },
                        { $set: { Price: result.Price, Timestamp: new Date() } }
                    );
                    await sendTelegramAlert(`Price Update for:\nCompany: ${result.Company}\nProduct: ${product}\nNew Price: ₹${result.Price}`);
                    console.log(`Price Update for:\nCompany: ${result.Company}\nProduct: ${result.Product}\nNew Price:₹${result.Price}`)
                }
            } else {
                await collection.insertOne({
                    Company: result.Company,
                    Product: product,
                    RealProduct : result.Product,
                    Price: result.Price,
                    Timestamp: new Date()
                });
                await sendTelegramAlert(`New product added:\nCompany: ${result.Company}\nProduct: ${product}\nPrice: ₹${result.Price}`);
                console.log(`New product added:\nCompany: ${result.Company}\nProduct: ${result.Product}\nPrice: ₹${result.Price}`);
            }
        }

        console.log(`Scraping completed for ${product}. Results saved to MongoDB.`);
        client.close();
    } catch (error) {
        console.log(`Error saving results: ${error}`);
    }
};

// Run scraper
const runScraper = async (product) => {
    const browser = await setupBrowser();
    const results = await scrapeGoogleShopping(browser, product);
    console.log(results);
    await saveResults(results, product);
    await new Promise(resolve => setTimeout(resolve, 5000));
    await browser.close();
};

// Schedule scraper with sequential execution
const scheduleScraper = async () => {
    console.log(`Starting sequential scraping for products every ${SCRAPE_INTERVAL_MINUTES} minutes`);

    // Sequentially scrape all products
    for (const product of PRODUCTS) {
        console.log(`Scraping ${product}`);
        await runScraper(product);
        console.log(`Finished scraping ${product}`);
    }
};

// Start the scraper when the app is started
app.get("/", async (req, res) => {
    const browser = await setupBrowser();
    browser.close();
    if (!global.scraperStarted) {
        await scheduleScraper();
        cron.schedule(`*/${SCRAPE_INTERVAL_MINUTES} * * * *`, async () => {
            await scheduleScraper(); // Sequentially scrape the products in intervals
        });
        global.scraperStarted = true;
    }
    res.send("Scraper started");
});

const removeParentheses = (str) => {
    // Replace parentheses while keeping the content inside and preserving spaces before and after
    return str.replace(/(\s?)\(([^)]*)\)(\s?)/g, '$1$2$3');
};


// Start server
app.listen(PORT, () => {
   
    console.log(`Server running on port ${PORT}`);
});
