const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
app.use(express.json());

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN || '7971577643:AAFcL38ZrahWxEyyIcz3dO4aC9yq9LTAD5M';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '1133538088'; // Replace with actual admin chat ID
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://evberyanshxxalxtwnnc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV2YmVyeWFuc2h4eGFseHR3bm5jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQwODMwOTcsImV4cCI6MjA1OTY1OTA5N30.pEoPiIi78Tvl5URw0Xy_vAxsd-3XqRlC8FTnX9HpgMw';
const PORT = process.env.PORT || 3000;

// Initialize Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Track processing transactions to prevent duplicates
const processingTransactions = new Set();
let subscription = null;

// Statistics tracking
const stats = {
  totalDeposits: 0,
  approvedDeposits: 0,
  rejectedDeposits: 0,
  totalAmount: 0,
  startTime: new Date()
};

// Webhook setup endpoint
app.get('/set-webhook', async (req, res) => {
  try {
    const url = `${process.env.RAILWAY_PUBLIC_DOMAIN || `http://localhost:${PORT}`}/webhook`;
    const response = await axios.get(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${url}`
    );
    
    await startDepositMonitoring();
    
    res.send({
      ...response.data,
      monitoring_status: 'Active',
      webhook_url: url,
      admin_chat_id: ADMIN_CHAT_ID
    });
  } catch (error) {
    console.error('Webhook setup failed:', error);
    res.status(500).send(error.message);
  }
});

// Start monitoring deposits
async function startDepositMonitoring() {
  await backfillPendingDeposits();
  
  subscription = supabase
    .channel('deposit-monitor')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'player_transactions',
        filter: 'transaction_type=eq.deposit'
      },
      (payload) => {
        if (payload.new.status === 'pending') {
          stats.totalDeposits++;
          stats.totalAmount += payload.new.amount;
          notificationQueue.push(payload.new);
          processNotificationQueue();
        }
      }
    )
    .subscribe();
}

// Process pending deposits queue
let notificationQueue = [];
let isProcessingQueue = false;

async function processNotificationQueue() {
  if (isProcessingQueue || notificationQueue.length === 0) return;
  
  isProcessingQueue = true;
  const deposit = notificationQueue.shift();
  
  try {
    await sendDepositNotification(deposit);
  } catch (error) {
    console.error('Error processing deposit:', deposit.id, error);
    if (deposit.retryCount === undefined) deposit.retryCount = 0;
    if (deposit.retryCount < 3) {
      deposit.retryCount++;
      notificationQueue.push(deposit);
    }
  }
  
  isProcessingQueue = false;
  if (notificationQueue.length > 0) {
    setTimeout(processNotificationQueue, 500);
  }
}

// Backfill any existing pending deposits
async function backfillPendingDeposits() {
  try {
    const { data: deposits, error } = await supabase
      .from('player_transactions')
      .select('*')
      .eq('status', 'pending')
      .eq('transaction_type', 'deposit')
      .order('created_at', { ascending: false });

    if (error) throw error;

    console.log(`Backfilling ${deposits.length} pending deposits`);
    notificationQueue.push(...deposits);
    processNotificationQueue();
  } catch (error) {
    console.error('Backfill error:', error);
  }
}

// Enhanced Telegram notification with image proof
async function sendDepositNotification(deposit) {
  // Extract file ID from description if it contains image proof
  const fileIdMatch = deposit.description?.match(/File ID: ([a-zA-Z0-9_-]+)/);
  const hasImageProof = fileIdMatch !== null;
  
  const message = `💰 *New Deposit Request* 💰\n\n` +
                 `🆔 *ID:* ${deposit.id}\n` +
                 `📱 *Phone:* ${deposit.player_phone}\n` +
                 `💵 *Amount:* ${deposit.amount.toFixed(2)} ETB\n` +
                 `📅 *Date:* ${new Date(deposit.created_at).toLocaleString()}\n` +
                 `📝 *Description:* ${deposit.description || 'None'}\n` +
                 `📸 *Image Proof:* ${hasImageProof ? '✅ Attached' : '❌ None'}\n\n` +
                 `_Please review this deposit request_`;

  const keyboard = [
    [
      { text: "✅ Approve", callback_data: `approve_${deposit.id}` },
      { text: "❌ Reject", callback_data: `reject_${deposit.id}` }
    ],
    [
      { text: "📝 View History", callback_data: `history_${deposit.player_phone}` },
      { text: "📊 User Stats", callback_data: `stats_${deposit.player_phone}` }
    ]
  ];

  // Add image viewing button if image proof exists
  if (hasImageProof) {
    keyboard.push([
      { text: "📸 View Image Proof", callback_data: `image_${fileIdMatch[1]}` }
    ]);
  }

  await axios.post(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      chat_id: ADMIN_CHAT_ID,
      text: message,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: keyboard
      }
    }
  );
}

// Get user statistics
async function getUserStats(phone) {
  try {
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phone)
      .single();

    if (userError) throw userError;

    const { data: transactions, error: txError } = await supabase
      .from('player_transactions')
      .select('*')
      .eq('player_phone', phone);

    if (txError) throw txError;

    const deposits = transactions.filter(tx => tx.transaction_type === 'deposit');
    const withdrawals = transactions.filter(tx => tx.transaction_type === 'withdrawal');
    const approvedDeposits = deposits.filter(tx => tx.status === 'approved');
    const totalDeposited = approvedDeposits.reduce((sum, tx) => sum + tx.amount, 0);
    const totalWithdrawn = withdrawals.filter(tx => tx.status === 'approved').reduce((sum, tx) => sum + Math.abs(tx.amount), 0);

    return `📊 *User Statistics* 📊\n\n` +
           `👤 *Username:* ${user.username}\n` +
           `📱 *Phone:* ${phone}\n` +
           `💰 *Current Balance:* ${user.balance.toFixed(2)} ETB\n` +
           `📅 *Joined:* ${new Date(user.created_at).toLocaleDateString()}\n\n` +
           `📈 *Transaction Summary:*\n` +
           `• Total Transactions: ${transactions.length}\n` +
           `• Total Deposits: ${deposits.length}\n` +
           `• Approved Deposits: ${approvedDeposits.length}\n` +
           `• Total Deposited: ${totalDeposited.toFixed(2)} ETB\n` +
           `• Total Withdrawn: ${totalWithdrawn.toFixed(2)} ETB\n` +
           `• Net Deposit: ${(totalDeposited - totalWithdrawn).toFixed(2)} ETB`;
  } catch (error) {
    throw error;
  }
}

// Get transaction history for a user
async function getTransactionHistory(phone) {
  const { data: transactions, error } = await supabase
    .from('player_transactions')
    .select('*')
    .eq('player_phone', phone)
    .order('created_at', { ascending: false })
    .limit(10);
    
  if (error) throw error;
  
  let message = `📝 *Transaction History* 📝\n\n` +
               `📱 *Phone:* ${phone}\n\n`;
               
  if (transactions.length === 0) {
    message += `No transactions found.`;
  } else {
    transactions.forEach((tx, index) => {
      const emoji = tx.transaction_type === 'deposit' ? '💰' : '💸';
      const statusEmoji = tx.status === 'approved' ? '✅' : (tx.status === 'rejected' ? '❌' : '⏳');
      
      message += `${emoji} *${tx.transaction_type.toUpperCase()}* ${statusEmoji}\n` +
                 `💵 Amount: ${tx.amount.toFixed(2)} ETB\n` +
                 `📅 Date: ${new Date(tx.created_at).toLocaleString()}\n` +
                 `📝 Desc: ${tx.description?.substring(0, 50) || 'None'}${tx.description?.length > 50 ? '...' : ''}\n`;
      
      if (index < transactions.length - 1) message += `----------------------------\n`;
    });
  }
  
  return message;
}

// Get system statistics
async function getSystemStats() {
  try {
    const { data: allTransactions, error } = await supabase
      .from('player_transactions')
      .select('*')
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()); // Last 24 hours

    if (error) throw error;

    const deposits = allTransactions.filter(tx => tx.transaction_type === 'deposit');
    const withdrawals = allTransactions.filter(tx => tx.transaction_type === 'withdrawal');
    const pendingDeposits = deposits.filter(tx => tx.status === 'pending');
    const approvedDeposits = deposits.filter(tx => tx.status === 'approved');
    const rejectedDeposits = deposits.filter(tx => tx.status === 'rejected');

    const totalDepositAmount = approvedDeposits.reduce((sum, tx) => sum + tx.amount, 0);
    const totalWithdrawalAmount = withdrawals.filter(tx => tx.status === 'approved').reduce((sum, tx) => sum + Math.abs(tx.amount), 0);

    return `📊 *System Statistics (24h)* 📊\n\n` +
           `⏰ *Uptime:* ${Math.floor((Date.now() - stats.startTime.getTime()) / (1000 * 60 * 60))}h ${Math.floor(((Date.now() - stats.startTime.getTime()) % (1000 * 60 * 60)) / (1000 * 60))}m\n\n` +
           `💰 *Deposits:*\n` +
           `• Total: ${deposits.length}\n` +
           `• Pending: ${pendingDeposits.length}\n` +
           `• Approved: ${approvedDeposits.length}\n` +
           `• Rejected: ${rejectedDeposits.length}\n` +
           `• Total Amount: ${totalDepositAmount.toFixed(2)} ETB\n\n` +
           `💸 *Withdrawals:*\n` +
           `• Total: ${withdrawals.length}\n` +
           `• Total Amount: ${totalWithdrawalAmount.toFixed(2)} ETB\n\n` +
           `📈 *Net Flow:* ${(totalDepositAmount - totalWithdrawalAmount).toFixed(2)} ETB\n` +
           `🔄 *Queue:* ${notificationQueue.length} pending notifications`;
  } catch (error) {
    throw error;
  }
}

// Send image proof to admin
async function sendImageProof(fileId) {
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      chat_id: ADMIN_CHAT_ID,
      photo: fileId,
      caption: '📸 *Deposit Image Proof*\n\nThis is the image proof submitted by the user for their deposit request.',
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('Error sending image proof:', error);
    throw error;
  }
}

// Main webhook handler
app.post('/webhook', async (req, res) => {
  try {
    const update = req.body;
    
    // Handle callback queries (button presses)
    if (update.callback_query) {
      const [action, identifier] = update.callback_query.data.split('_');
      
      // Handle approve/reject actions
      if (action === 'approve' || action === 'reject') {
        const txId = identifier;
        
        // Prevent duplicate processing
        if (processingTransactions.has(txId)) {
          console.log(`Transaction ${txId} is already being processed`);
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `Transaction is already being processed!`,
            show_alert: true
          });
          return res.send('OK');
        }
        
        processingTransactions.add(txId);
        console.log(`Processing transaction ${txId} (${action})`);
        
        try {
          // Check current transaction status
          const { data: currentTx, error: txError } = await supabase
            .from('player_transactions')
            .select('status, player_phone, amount')
            .eq('id', txId)
            .single();
            
          if (txError || !currentTx) {
            throw new Error(txError?.message || 'Transaction not found');
          }
          
          if (currentTx.status !== 'pending') {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
              callback_query_id: update.callback_query.id,
              text: `Transaction already ${currentTx.status}!`,
              show_alert: true
            });
            return res.send('OK');
          }
          
          const status = action === 'approve' ? 'approved' : 'rejected';
          let newBalance = null;
          
          // Update transaction status
          const { error: updateError } = await supabase
            .from('player_transactions')
            .update({ 
              status,
              processed_at: new Date().toISOString(),
              processed_by: 'Admin Bot'
            })
            .eq('id', txId);
            
          if (updateError) throw updateError;
          
          // Update statistics
          if (action === 'approve') {
            stats.approvedDeposits++;
          } else {
            stats.rejectedDeposits++;
          }
          
          // Update user balance if approved
          if (action === 'approve') {
            const { data: user, error: userError } = await supabase
              .from('users')
              .select('balance')
              .eq('phone', currentTx.player_phone)
              .single();
              
            if (userError) throw userError;
            
            newBalance = (user?.balance || 0) + currentTx.amount;
            
            const { error: balanceError } = await supabase
              .from('users')
              .update({ balance: newBalance })
              .eq('phone', currentTx.player_phone);
              
            if (balanceError) throw balanceError;
          }
          
          // Update Telegram message
          const newMessage = `${update.callback_query.message.text}\n\n` +
                           `✅ *Status:* ${status.toUpperCase()}\n` +
                           `⏱ *Processed At:* ${new Date().toLocaleString()}\n` +
                           `👤 *Processed By:* Admin Bot\n` +
                           (action === 'approve' ? 
                            `💰 *New Balance:* ${newBalance.toFixed(2)} ETB` : '');
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
            chat_id: update.callback_query.message.chat.id,
            message_id: update.callback_query.message.message_id,
            text: newMessage,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [] }
          });
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `Transaction ${status} successfully!`,
            show_alert: false
          });
          
        } catch (error) {
          console.error('Error processing transaction:', error);
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: `❌ Error processing transaction ${txId}:\n\n<code>${error.message}</code>`,
            parse_mode: 'HTML'
          });
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `Error: ${error.message.substring(0, 50)}...`,
            show_alert: true
          });
        } finally {
          processingTransactions.delete(txId);
        }
      }
      // Handle history request
      else if (action === 'history') {
        const phone = identifier;
        
        try {
          const history = await getTransactionHistory(phone);
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `Showing transaction history for ${phone}`,
            show_alert: false
          });
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: history,
            parse_mode: 'Markdown'
          });
        } catch (error) {
          console.error('Error fetching history:', error);
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `Error loading history!`,
            show_alert: true
          });
        }
      }
      // Handle user stats request
      else if (action === 'stats') {
        const phone = identifier;
        
        try {
          const userStats = await getUserStats(phone);
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `Showing user statistics for ${phone}`,
            show_alert: false
          });
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: userStats,
            parse_mode: 'Markdown'
          });
        } catch (error) {
          console.error('Error fetching user stats:', error);
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `Error loading user stats!`,
            show_alert: true
          });
        }
      }
      // Handle image proof viewing
      else if (action === 'image') {
        const fileId = identifier;
        
        try {
          await sendImageProof(fileId);
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `Image proof sent!`,
            show_alert: false
          });
        } catch (error) {
          console.error('Error sending image proof:', error);
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `Error loading image proof!`,
            show_alert: true
          });
        }
      }
    }
    
    // Handle text commands
    if (update.message && update.message.text) {
      const text = update.message.text.toLowerCase();
      const chatId = update.message.chat.id;
      
      // Only respond to admin
      if (chatId.toString() !== ADMIN_CHAT_ID) {
        return res.send('OK');
      }
      
      if (text === '/stats' || text === '/statistics') {
        try {
          const systemStats = await getSystemStats();
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: systemStats,
            parse_mode: 'Markdown'
          });
        } catch (error) {
          console.error('Error getting system stats:', error);
        }
      }
      
      if (text === '/help') {
        const helpMessage = `🤖 *Admin Bot Commands* 🤖\n\n` +
                           `📊 /stats - View system statistics\n` +
                           `❓ /help - Show this help message\n` +
                           `🔄 /restart - Restart monitoring\n` +
                           `📋 /pending - Show pending deposits\n\n` +
                           `*Automatic Features:*\n` +
                           `• Real-time deposit notifications\n` +
                           `• Image proof viewing\n` +
                           `• User transaction history\n` +
                           `• User statistics\n` +
                           `• Approve/Reject with one click`;
        
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          chat_id: ADMIN_CHAT_ID,
          text: helpMessage,
          parse_mode: 'Markdown'
        });
      }
      
      if (text === '/restart') {
        try {
          await startDepositMonitoring();
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: '🔄 Monitoring restarted successfully!'
          });
        } catch (error) {
          console.error('Error restarting monitoring:', error);
        }
      }
      
      if (text === '/pending') {
        try {
          const { data: pendingDeposits, error } = await supabase
            .from('player_transactions')
            .select('*')
            .eq('status', 'pending')
            .eq('transaction_type', 'deposit')
            .order('created_at', { ascending: false })
            .limit(5);
          
          if (error) throw error;
          
          if (pendingDeposits.length === 0) {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
              chat_id: ADMIN_CHAT_ID,
              text: '✅ No pending deposits!'
            });
          } else {
            for (const deposit of pendingDeposits) {
              await sendDepositNotification(deposit);
            }
          }
        } catch (error) {
          console.error('Error fetching pending deposits:', error);
        }
      }
    }
    
    res.send('OK');
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).send('Error processing request');
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send(`
    <h1>🤖 Enhanced Deposit Approval System</h1>
    <p><strong>Server Status:</strong> ✅ Running</p>
    <p><strong>Uptime:</strong> ${Math.floor((Date.now() - stats.startTime.getTime()) / (1000 * 60))} minutes</p>
    
    <h2>📊 Statistics</h2>
    <ul>
      <li><strong>Total Deposits:</strong> ${stats.totalDeposits}</li>
      <li><strong>Approved:</strong> ${stats.approvedDeposits}</li>
      <li><strong>Rejected:</strong> ${stats.rejectedDeposits}</li>
      <li><strong>Total Amount:</strong> ${stats.totalAmount.toFixed(2)} ETB</li>
    </ul>
    
    <h2>🔧 System Info</h2>
    <ul>
      <li><a href="/set-webhook">🔗 Setup Webhook</a></li>
      <li><strong>Webhook URL:</strong> <code>/webhook</code></li>
      <li><strong>Monitoring Status:</strong> ${subscription ? '✅ Active' : '❌ Inactive'}</li>
      <li><strong>Pending Notifications:</strong> ${notificationQueue.length}</li>
      <li><strong>Processing Transactions:</strong> ${processingTransactions.size}</li>
      <li><strong>Admin Chat ID:</strong> ${ADMIN_CHAT_ID}</li>
    </ul>
    
    <h2>✨ Features</h2>
    <ul>
      <li>📸 Image proof viewing</li>
      <li>📊 User statistics</li>
      <li>📝 Transaction history</li>
      <li>⚡ Real-time notifications</li>
      <li>🔄 Auto-retry failed notifications</li>
      <li>📈 System statistics</li>
    </ul>
  `);
});

// Scheduled tasks
cron.schedule('0 */6 * * *', async () => {
  console.log('Running scheduled maintenance...');
  try {
    const systemStats = await getSystemStats();
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: ADMIN_CHAT_ID,
      text: `🔄 *Scheduled Report*\n\n${systemStats}`,
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('Scheduled task error:', error);
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Enhanced Admin Bot Server running on port ${PORT}`);
  console.log(`📡 Webhook URL: ${process.env.RAILWAY_PUBLIC_DOMAIN || `http://localhost:${PORT}`}/webhook`);
  console.log(`👤 Admin Chat ID: ${ADMIN_CHAT_ID}`);
  
  if (process.env.NODE_ENV === 'production') {
    startDepositMonitoring();
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  if (subscription) {
    subscription.unsubscribe();
  }
  process.exit(0);
});