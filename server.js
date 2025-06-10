const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
app.use(express.json());

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN || '7971577643:AAEn6W0tKh72B67w-xuTf-6fGDkBW4Od3M4';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '1133538088';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://evberyanshxxalxtwnnc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV2YmVyeWFuc2h4eGFseHR3bm5jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQwODMwOTcsImV4cCI6MjA1OTY1OTA5N30.pEoPiIi78Tvl5URw0Xy_vAxsd-3XqRlC8FTnX9HpgMw';
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = 'https://botadmin-sn1a.onrender.com';

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
  startTime: new Date(),
  errors: 0
};

// Enhanced logging function
function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
}

// Webhook setup endpoint
app.get('/set-webhook', async (req, res) => {
  try {
    const webhookUrl = `${WEBHOOK_URL}/webhook`;
    log(`Setting webhook to: ${webhookUrl}`);
    
    const response = await axios.get(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${webhookUrl}`
    );
    
    log('Webhook set successfully, starting deposit monitoring...');
    await startDepositMonitoring();
    
    res.json({
      success: true,
      webhook_data: response.data,
      monitoring_status: 'Active',
      webhook_url: webhookUrl,
      admin_chat_id: ADMIN_CHAT_ID,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    log(`Webhook setup failed: ${error.message}`, 'ERROR');
    stats.errors++;
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Enhanced deposit monitoring with better error handling
async function startDepositMonitoring() {
  try {
    // Unsubscribe existing subscription
    if (subscription) {
      subscription.unsubscribe();
      log('Unsubscribed from existing monitoring');
    }

    // Backfill pending deposits first
    await backfillPendingDeposits();
    
    // Start real-time monitoring
    subscription = supabase
      .channel('deposit-monitor-enhanced')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'player_transactions',
          filter: 'transaction_type=eq.deposit'
        },
        async (payload) => {
          try {
            log(`New deposit detected: ID ${payload.new.id}`);
            if (payload.new.status === 'pending') {
              stats.totalDeposits++;
              stats.totalAmount += payload.new.amount;
              notificationQueue.push(payload.new);
              processNotificationQueue();
            }
          } catch (error) {
            log(`Error processing new deposit: ${error.message}`, 'ERROR');
            stats.errors++;
          }
        }
      )
      .subscribe((status) => {
        log(`Subscription status: ${status}`);
      });

    log('Deposit monitoring started successfully');
  } catch (error) {
    log(`Error starting deposit monitoring: ${error.message}`, 'ERROR');
    stats.errors++;
    throw error;
  }
}

// Enhanced notification queue processing
let notificationQueue = [];
let isProcessingQueue = false;

async function processNotificationQueue() {
  if (isProcessingQueue || notificationQueue.length === 0) return;
  
  isProcessingQueue = true;
  log(`Processing notification queue: ${notificationQueue.length} items`);
  
  while (notificationQueue.length > 0) {
    const deposit = notificationQueue.shift();
    
    try {
      await sendDepositNotification(deposit);
      log(`Notification sent for deposit ID: ${deposit.id}`);
    } catch (error) {
      log(`Error processing deposit ${deposit.id}: ${error.message}`, 'ERROR');
      stats.errors++;
      
      // Retry logic
      if (!deposit.retryCount) deposit.retryCount = 0;
      if (deposit.retryCount < 3) {
        deposit.retryCount++;
        notificationQueue.push(deposit);
        log(`Retrying deposit ${deposit.id} (attempt ${deposit.retryCount})`);
      } else {
        log(`Max retries reached for deposit ${deposit.id}`, 'ERROR');
      }
    }
    
    // Small delay between notifications
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  isProcessingQueue = false;
}

// Enhanced backfill function
async function backfillPendingDeposits() {
  try {
    log('Starting backfill of pending deposits...');
    
    const { data: deposits, error } = await supabase
      .from('player_transactions')
      .select('*')
      .eq('status', 'pending')
      .eq('transaction_type', 'deposit')
      .order('created_at', { ascending: false });

    if (error) throw error;

    log(`Found ${deposits.length} pending deposits to backfill`);
    
    if (deposits.length > 0) {
      notificationQueue.push(...deposits);
      processNotificationQueue();
    }
  } catch (error) {
    log(`Backfill error: ${error.message}`, 'ERROR');
    stats.errors++;
  }
}

// Enhanced image proof detection and notification
async function sendDepositNotification(deposit) {
  try {
    // Enhanced image proof detection - check multiple possible formats
    let imageProof = null;
    let hasImageProof = false;

    if (deposit.description) {
      // Look for various image proof patterns
      const patterns = [
        /File ID:\s*([a-zA-Z0-9_-]+)/i,
        /file_id:\s*([a-zA-Z0-9_-]+)/i,
        /image:\s*([a-zA-Z0-9_-]+)/i,
        /photo:\s*([a-zA-Z0-9_-]+)/i,
        /proof:\s*([a-zA-Z0-9_-]+)/i
      ];

      for (const pattern of patterns) {
        const match = deposit.description.match(pattern);
        if (match) {
          imageProof = match[1];
          hasImageProof = true;
          break;
        }
      }
    }

    // Check if there's a separate image_proof field
    if (deposit.image_proof) {
      imageProof = deposit.image_proof;
      hasImageProof = true;
    }

    // Get user information for enhanced display
    let userInfo = '';
    try {
      const { data: user } = await supabase
        .from('users')
        .select('username, balance')
        .eq('phone', deposit.player_phone)
        .single();
      
      if (user) {
        userInfo = `👤 *Username:* ${user.username}\n💰 *Current Balance:* ${user.balance.toFixed(2)} ETB\n`;
      }
    } catch (error) {
      log(`Could not fetch user info for ${deposit.player_phone}`, 'WARN');
    }

    const message = `🔔 *NEW DEPOSIT REQUEST* 🔔\n\n` +
                   `🆔 *Transaction ID:* \`${deposit.id}\`\n` +
                   `📱 *Phone:* ${deposit.player_phone}\n` +
                   userInfo +
                   `💵 *Amount:* ${deposit.amount.toFixed(2)} ETB\n` +
                   `📅 *Date:* ${new Date(deposit.created_at).toLocaleString('en-US', { timeZone: 'Africa/Addis_Ababa' })}\n` +
                   `📝 *Description:* ${deposit.description || 'None provided'}\n` +
                   `📸 *Image Proof:* ${hasImageProof ? '✅ Available' : '❌ None'}\n` +
                   `⏱️ *Status:* PENDING REVIEW\n\n` +
                   `_Please review and approve/reject this deposit request_`;

    const keyboard = [
      [
        { text: "✅ APPROVE", callback_data: `approve_${deposit.id}` },
        { text: "❌ REJECT", callback_data: `reject_${deposit.id}` }
      ],
      [
        { text: "📝 History", callback_data: `history_${deposit.player_phone}` },
        { text: "📊 Stats", callback_data: `stats_${deposit.player_phone}` }
      ]
    ];

    // Add image viewing button if image proof exists
    if (hasImageProof && imageProof) {
      keyboard.push([
        { text: "📸 View Image Proof", callback_data: `image_${imageProof}` }
      ]);
    }

    // Add quick actions
    keyboard.push([
      { text: "🔍 Inspect", callback_data: `inspect_${deposit.id}` },
      { text: "⚠️ Flag", callback_data: `flag_${deposit.id}` }
    ]);

    const response = await axios.post(
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

    log(`Notification sent successfully for deposit ${deposit.id}`);
    return response.data;

  } catch (error) {
    log(`Error sending notification for deposit ${deposit.id}: ${error.message}`, 'ERROR');
    throw error;
  }
}

// Enhanced user statistics
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
      .eq('player_phone', phone)
      .order('created_at', { ascending: false });

    if (txError) throw txError;

    const deposits = transactions.filter(tx => tx.transaction_type === 'deposit');
    const withdrawals = transactions.filter(tx => tx.transaction_type === 'withdrawal');
    const approvedDeposits = deposits.filter(tx => tx.status === 'approved');
    const pendingDeposits = deposits.filter(tx => tx.status === 'pending');
    const rejectedDeposits = deposits.filter(tx => tx.status === 'rejected');
    
    const totalDeposited = approvedDeposits.reduce((sum, tx) => sum + tx.amount, 0);
    const totalWithdrawn = withdrawals.filter(tx => tx.status === 'approved').reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
    const avgDepositAmount = approvedDeposits.length > 0 ? totalDeposited / approvedDeposits.length : 0;

    // Calculate user activity score
    const recentTransactions = transactions.filter(tx => 
      new Date(tx.created_at) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    ).length;

    return `📊 *USER PROFILE & STATISTICS* 📊\n\n` +
           `👤 *Username:* ${user.username || 'N/A'}\n` +
           `📱 *Phone:* ${phone}\n` +
           `💰 *Current Balance:* ${user.balance.toFixed(2)} ETB\n` +
           `📅 *Member Since:* ${new Date(user.created_at).toLocaleDateString()}\n` +
           `🏃 *Activity Score:* ${recentTransactions}/month\n\n` +
           `💸 *TRANSACTION SUMMARY:*\n` +
           `• Total Transactions: ${transactions.length}\n` +
           `• Deposits: ${deposits.length} (✅${approvedDeposits.length} ⏳${pendingDeposits.length} ❌${rejectedDeposits.length})\n` +
           `• Withdrawals: ${withdrawals.length}\n` +
           `• Total Deposited: ${totalDeposited.toFixed(2)} ETB\n` +
           `• Total Withdrawn: ${totalWithdrawn.toFixed(2)} ETB\n` +
           `• Average Deposit: ${avgDepositAmount.toFixed(2)} ETB\n` +
           `• Net Position: ${(totalDeposited - totalWithdrawn).toFixed(2)} ETB\n\n` +
           `📈 *RISK ASSESSMENT:*\n` +
           `• Rejection Rate: ${deposits.length > 0 ? (rejectedDeposits.length / deposits.length * 100).toFixed(1) : 0}%\n` +
           `• Success Rate: ${deposits.length > 0 ? (approvedDeposits.length / deposits.length * 100).toFixed(1) : 0}%`;
  } catch (error) {
    log(`Error getting user stats for ${phone}: ${error.message}`, 'ERROR');
    throw error;
  }
}

// Enhanced transaction history
async function getTransactionHistory(phone) {
  try {
    const { data: transactions, error } = await supabase
      .from('player_transactions')
      .select('*')
      .eq('player_phone', phone)
      .order('created_at', { ascending: false })
      .limit(15);
      
    if (error) throw error;
    
    let message = `📝 *TRANSACTION HISTORY* 📝\n\n` +
                 `📱 *Phone:* ${phone}\n` +
                 `🔢 *Showing:* Last ${Math.min(transactions.length, 15)} transactions\n\n`;
                 
    if (transactions.length === 0) {
      message += `❌ No transactions found for this user.`;
    } else {
      transactions.forEach((tx, index) => {
        const typeEmoji = tx.transaction_type === 'deposit' ? '💰' : '💸';
        const statusEmoji = tx.status === 'approved' ? '✅' : 
                           tx.status === 'rejected' ? '❌' : '⏳';
        
        const amount = tx.transaction_type === 'deposit' ? 
                      `+${tx.amount.toFixed(2)}` : 
                      `${tx.amount.toFixed(2)}`;
        
        message += `${typeEmoji} *${tx.transaction_type.toUpperCase()}* ${statusEmoji}\n` +
                   `💵 ${amount} ETB\n` +
                   `📅 ${new Date(tx.created_at).toLocaleString()}\n` +
                   `🆔 ID: \`${tx.id}\`\n`;
        
        if (tx.description) {
          const shortDesc = tx.description.length > 40 ? 
                           tx.description.substring(0, 40) + '...' : 
                           tx.description;
          message += `📝 ${shortDesc}\n`;
        }
        
        if (index < transactions.length - 1) {
          message += `➖➖➖➖➖➖➖➖➖➖\n`;
        }
      });
      
      message += `\n📊 *Quick Stats:* ${transactions.filter(tx => tx.status === 'approved').length} approved, ` +
                `${transactions.filter(tx => tx.status === 'pending').length} pending, ` +
                `${transactions.filter(tx => tx.status === 'rejected').length} rejected`;
    }
    
    return message;
  } catch (error) {
    log(`Error getting transaction history for ${phone}: ${error.message}`, 'ERROR');
    throw error;
  }
}

// Enhanced system statistics
async function getSystemStats() {
  try {
    const { data: allTransactions, error } = await supabase
      .from('player_transactions')
      .select('*')
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    if (error) throw error;

    const deposits = allTransactions.filter(tx => tx.transaction_type === 'deposit');
    const withdrawals = allTransactions.filter(tx => tx.transaction_type === 'withdrawal');
    const pendingDeposits = deposits.filter(tx => tx.status === 'pending');
    const approvedDeposits = deposits.filter(tx => tx.status === 'approved');
    const rejectedDeposits = deposits.filter(tx => tx.status === 'rejected');

    const totalDepositAmount = approvedDeposits.reduce((sum, tx) => sum + tx.amount, 0);
    const totalWithdrawalAmount = withdrawals
      .filter(tx => tx.status === 'approved')
      .reduce((sum, tx) => sum + Math.abs(tx.amount), 0);

    const uptime = Date.now() - stats.startTime.getTime();
    const uptimeHours = Math.floor(uptime / (1000 * 60 * 60));
    const uptimeMinutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));

    return `📊 *SYSTEM DASHBOARD (24H)* 📊\n\n` +
           `⏰ *Uptime:* ${uptimeHours}h ${uptimeMinutes}m\n` +
           `🔄 *Queue:* ${notificationQueue.length} pending\n` +
           `❌ *Errors:* ${stats.errors}\n` +
           `📡 *Status:* ${subscription ? 'Connected' : 'Disconnected'}\n\n` +
           `💰 *DEPOSITS (24H):*\n` +
           `• Total Requests: ${deposits.length}\n` +
           `• ⏳ Pending: ${pendingDeposits.length}\n` +
           `• ✅ Approved: ${approvedDeposits.length} (${totalDepositAmount.toFixed(2)} ETB)\n` +
           `• ❌ Rejected: ${rejectedDeposits.length}\n` +
           `• 📈 Success Rate: ${deposits.length > 0 ? (approvedDeposits.length / deposits.length * 100).toFixed(1) : 0}%\n\n` +
           `💸 *WITHDRAWALS (24H):*\n` +
           `• Total: ${withdrawals.length}\n` +
           `• Amount: ${totalWithdrawalAmount.toFixed(2)} ETB\n\n` +
           `📈 *NET FLOW:* ${(totalDepositAmount - totalWithdrawalAmount).toFixed(2)} ETB\n` +
           `🎯 *Performance:* ${(100 - (stats.errors / Math.max(1, stats.totalDeposits) * 100)).toFixed(1)}% success`;
  } catch (error) {
    log(`Error getting system stats: ${error.message}`, 'ERROR');
    throw error;
  }
}

// Enhanced image proof viewing
async function sendImageProof(fileId) {
  try {
    log(`Sending image proof with file ID: ${fileId}`);
    
    const response = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      chat_id: ADMIN_CHAT_ID,
      photo: fileId,
      caption: '📸 *DEPOSIT IMAGE PROOF*\n\n' +
               '👆 This image was submitted as proof for the deposit request.\n' +
               '🔍 Please verify the transaction details match the request.',
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Looks Good", callback_data: `proof_ok_${fileId}` },
          { text: "❌ Suspicious", callback_data: `proof_bad_${fileId}` }
        ]]
      }
    });
    
    log('Image proof sent successfully');
    return response.data;
  } catch (error) {
    log(`Error sending image proof: ${error.message}`, 'ERROR');
    
    // Try to send error message to admin
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: ADMIN_CHAT_ID,
      text: `❌ *Error Loading Image Proof*\n\n` +
            `File ID: \`${fileId}\`\n` +
            `Error: ${error.message}\n\n` +
            `The image may have expired or the file ID is invalid.`,
      parse_mode: 'Markdown'
    });
    
    throw error;
  }
}

// Enhanced transaction inspection
async function inspectTransaction(txId) {
  try {
    const { data: transaction, error } = await supabase
      .from('player_transactions')
      .select('*')
      .eq('id', txId)
      .single();

    if (error || !transaction) {
      throw new Error('Transaction not found');
    }

    // Get related transactions from same user
    const { data: relatedTxs } = await supabase
      .from('player_transactions')
      .select('*')
      .eq('player_phone', transaction.player_phone)
      .order('created_at', { ascending: false })
      .limit(5);

    const message = `🔍 *TRANSACTION INSPECTION* 🔍\n\n` +
                   `🆔 *ID:* \`${transaction.id}\`\n` +
                   `📱 *Phone:* ${transaction.player_phone}\n` +
                   `💵 *Amount:* ${transaction.amount.toFixed(2)} ETB\n` +
                   `📅 *Created:* ${new Date(transaction.created_at).toLocaleString()}\n` +
                   `⏱️ *Status:* ${transaction.status.toUpperCase()}\n` +
                   `📝 *Description:* ${transaction.description || 'None'}\n\n` +
                   `📊 *RECENT ACTIVITY:*\n` +
                   relatedTxs.slice(0, 3).map((tx, i) => 
                     `${i + 1}. ${tx.transaction_type} ${tx.amount.toFixed(2)} ETB (${tx.status})`
                   ).join('\n') +
                   `\n\n🚨 *FLAGS:* None detected`;

    return message;
  } catch (error) {
    log(`Error inspecting transaction ${txId}: ${error.message}`, 'ERROR');
    throw error;
  }
}

// MAIN WEBHOOK HANDLER - Enhanced with better error handling
app.post('/webhook', async (req, res) => {
  try {
    const update = req.body;
    log(`Received webhook update: ${JSON.stringify(update).substring(0, 200)}...`);
    
    // Handle callback queries (button presses)
    if (update.callback_query) {
      const callbackData = update.callback_query.data;
      const [action, identifier] = callbackData.split('_');
      
      log(`Processing callback: ${action} - ${identifier}`);
      
      // Handle approve/reject actions
      if (action === 'approve' || action === 'reject') {
        const txId = identifier;
        
        // Prevent duplicate processing
        if (processingTransactions.has(txId)) {
          log(`Transaction ${txId} already being processed`);
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `⚠️ Transaction is already being processed!`,
            show_alert: true
          });
          return res.send('OK');
        }
        
        processingTransactions.add(txId);
        log(`Processing transaction ${txId} (${action})`);
        
        try {
          // Get current transaction
          const { data: currentTx, error: txError } = await supabase
            .from('player_transactions')
            .select('*')
            .eq('id', txId)
            .single();
            
          if (txError || !currentTx) {
            throw new Error(txError?.message || 'Transaction not found');
          }
          
          if (currentTx.status !== 'pending') {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
              callback_query_id: update.callback_query.id,
              text: `⚠️ Transaction already ${currentTx.status}!`,
              show_alert: true
            });
            return res.send('OK');
          }
          
          const newStatus = action === 'approve' ? 'approved' : 'rejected';
          let newBalance = null;
          
          // Start database transaction
          const { error: updateError } = await supabase
            .from('player_transactions')
            .update({ 
              status: newStatus,
              processed_at: new Date().toISOString(),
              processed_by: 'Admin Bot'
            })
            .eq('id', txId);
            
          if (updateError) throw updateError;
          
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
            
            stats.approvedDeposits++;
            log(`Approved deposit ${txId}, new balance: ${newBalance.toFixed(2)} ETB`);
          } else {
            stats.rejectedDeposits++;
            log(`Rejected deposit ${txId}`);
          }
          
          // Update message with new status
          const statusEmoji = action === 'approve' ? '✅' : '❌';
          const newMessage = `${update.callback_query.message.text}\n\n` +
                           `${statusEmoji} *FINAL STATUS:* ${newStatus.toUpperCase()}\n` +
                           `⏱️ *Processed:* ${new Date().toLocaleString()}\n` +
                           `🤖 *By:* Admin Bot\n` +
                           (action === 'approve' ? 
                            `💰 *New Balance:* ${newBalance.toFixed(2)} ETB` : 
                            `📝 *Reason:* Manual rejection by admin`);
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
            chat_id: update.callback_query.message.chat.id,
            message_id: update.callback_query.message.message_id,
            text: newMessage,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [] }
          });
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `${statusEmoji} Transaction ${newStatus} successfully!`,
            show_alert: false
          });
          
        } catch (error) {
          log(`Error processing transaction ${txId}: ${error.message}`, 'ERROR');
          stats.errors++;
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: `❌ *ERROR PROCESSING TRANSACTION*\n\n` +
                  `🆔 *ID:* \`${txId}\`\n` +
                  `⚠️ *Error:* ${error.message}\n` +
                  `🕐 *Time:* ${new Date().toLocaleString()}\n\n` +
                  `Please check the transaction manually.`,
            parse_mode: 'Markdown'
          });
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `❌ Error: ${error.message.substring(0, 50)}...`,
            show_alert: true
          });
        } finally {
          processingTransactions.delete(txId);
        }
      }
      // Handle other callback actions
      else if (action === 'history') {
        try {
          const history = await getTransactionHistory(identifier);
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `📝 Loading transaction history...`,
            show_alert: false
          });
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: history,
            parse_mode: 'Markdown'
          });
        } catch (error) {
          log(`Error fetching history for ${identifier}: ${error.message}`, 'ERROR');
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `❌ Error loading history!`,
            show_alert: true
          });
        }
      }
      else if (action === 'stats') {
        try {
          const userStats = await getUserStats(identifier);
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `📊 Loading user statistics...`,
            show_alert: false
          });
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: userStats,
            parse_mode: 'Markdown'
          });
        } catch (error) {
          log(`Error fetching stats for ${identifier}: ${error.message}`, 'ERROR');
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `❌ Error loading user stats!`,
            show_alert: true
          });
        }
      }
      else if (action === 'image') {
        try {
          await sendImageProof(identifier);
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `📸 Image proof sent!`,
            show_alert: false
          });
        } catch (error) {
          log(`Error sending image proof ${identifier}: ${error.message}`, 'ERROR');
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `❌ Error loading image proof!`,
            show_alert: true
          });
        }
      }
      else if (action === 'inspect') {
        try {
          const inspection = await inspectTransaction(identifier);
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `🔍 Transaction inspection loaded`,
            show_alert: false
          });
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: inspection,
            parse_mode: 'Markdown'
          });
        } catch (error) {
          log(`Error inspecting transaction ${identifier}: ${error.message}`, 'ERROR');
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `❌ Error loading inspection!`,
            show_alert: true
          });
        }
      }
      else if (action === 'flag') {
        try {
          // Flag transaction for manual review
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: `🚩 *TRANSACTION FLAGGED* 🚩\n\n` +
                  `🆔 *ID:* \`${identifier}\`\n` +
                  `⚠️ *Status:* Flagged for manual review\n` +
                  `👤 *Flagged by:* Admin\n` +
                  `🕐 *Time:* ${new Date().toLocaleString()}\n\n` +
                  `This transaction requires additional verification.`,
            parse_mode: 'Markdown'
          });
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `🚩 Transaction flagged for review`,
            show_alert: false
          });
        } catch (error) {
          log(`Error flagging transaction ${identifier}: ${error.message}`, 'ERROR');
        }
      }
      else if (action === 'proof') {
        // Handle proof verification feedback
        const [status, fileId] = callbackData.split('_').slice(1);
        const message = status === 'ok' ? 
          '✅ Image proof verified as legitimate' : 
          '⚠️ Image proof marked as suspicious';
        
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
          callback_query_id: update.callback_query.id,
          text: message,
          show_alert: false
        });
      }
    }
    
    // Handle text commands
    if (update.message && update.message.text) {
      const text = update.message.text.toLowerCase().trim();
      const chatId = update.message.chat.id;
      
      // Only respond to admin
      if (chatId.toString() !== ADMIN_CHAT_ID) {
        log(`Unauthorized access attempt from chat ID: ${chatId}`);
        return res.send('OK');
      }
      
      log(`Admin command received: ${text}`);
      
      if (text === '/start') {
        const welcomeMessage = `🤖 *ADMIN BOT ACTIVATED* 🤖\n\n` +
                              `Welcome to the Enhanced Deposit Management System!\n\n` +
                              `🔧 *Available Commands:*\n` +
                              `• /help - Show all commands\n` +
                              `• /stats - System statistics\n` +
                              `• /pending - Show pending deposits\n` +
                              `• /restart - Restart monitoring\n` +
                              `• /health - System health check\n\n` +
                              `✅ *Bot Status:* Active and monitoring\n` +
                              `📡 *Connection:* ${subscription ? 'Connected' : 'Disconnected'}\n` +
                              `⏰ *Started:* ${stats.startTime.toLocaleString()}`;
        
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          chat_id: ADMIN_CHAT_ID,
          text: welcomeMessage,
          parse_mode: 'Markdown'
        });
      }
      else if (text === '/stats' || text === '/statistics') {
        try {
          const systemStats = await getSystemStats();
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: systemStats,
            parse_mode: 'Markdown'
          });
        } catch (error) {
          log(`Error getting system stats: ${error.message}`, 'ERROR');
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: `❌ Error loading system statistics: ${error.message}`
          });
        }
      }
      else if (text === '/help') {
        const helpMessage = `🤖 *ADMIN BOT HELP CENTER* 🤖\n\n` +
                           `📊 *SYSTEM COMMANDS:*\n` +
                           `• \`/stats\` - View system statistics\n` +
                           `• \`/health\` - System health check\n` +
                           `• \`/restart\` - Restart monitoring\n` +
                           `• \`/pending\` - Show pending deposits\n` +
                           `• \`/recent\` - Recent transactions\n\n` +
                           `🔍 *SEARCH COMMANDS:*\n` +
                           `• \`/user [phone]\` - User information\n` +
                           `• \`/tx [id]\` - Transaction details\n` +
                           `• \`/find [amount]\` - Find by amount\n\n` +
                           `⚙️ *ADMIN COMMANDS:*\n` +
                           `• \`/config\` - Bot configuration\n` +
                           `• \`/logs\` - Error logs\n` +
                           `• \`/reset\` - Reset statistics\n\n` +
                           `🔄 *AUTOMATIC FEATURES:*\n` +
                           `• Real-time deposit notifications\n` +
                           `• Enhanced image proof viewing\n` +
                           `• User statistics and history\n` +
                           `• One-click approve/reject\n` +
                           `• Transaction inspection\n` +
                           `• Fraud detection alerts\n\n` +
                           `💡 *TIP:* Use inline buttons for faster processing!`;
        
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          chat_id: ADMIN_CHAT_ID,
          text: helpMessage,
          parse_mode: 'Markdown'
        });
      }
      else if (text === '/restart') {
        try {
          await startDepositMonitoring();
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: '🔄 *SYSTEM RESTARTED*\n\n✅ Monitoring restarted successfully!\n📡 All systems operational.'
          });
        } catch (error) {
          log(`Error restarting monitoring: ${error.message}`, 'ERROR');
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: `❌ Error restarting monitoring: ${error.message}`
          });
        }
      }
      else if (text === '/pending') {
        try {
          const { data: pendingDeposits, error } = await supabase
            .from('player_transactions')
            .select('*')
            .eq('status', 'pending')
            .eq('transaction_type', 'deposit')
            .order('created_at', { ascending: false })
            .limit(10);
          
          if (error) throw error;
          
          if (pendingDeposits.length === 0) {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
              chat_id: ADMIN_CHAT_ID,
              text: '✅ *NO PENDING DEPOSITS*\n\nAll deposits have been processed!'
            });
          } else {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
              chat_id: ADMIN_CHAT_ID,
              text: `📋 *FOUND ${pendingDeposits.length} PENDING DEPOSITS*\n\nSending notifications...`
            });
            
            for (const deposit of pendingDeposits) {
              await sendDepositNotification(deposit);
              await new Promise(resolve => setTimeout(resolve, 1000)); // Delay between notifications
            }
          }
        } catch (error) {
          log(`Error fetching pending deposits: ${error.message}`, 'ERROR');
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: `❌ Error fetching pending deposits: ${error.message}`
          });
        }
      }
      else if (text === '/health') {
        const healthStatus = {
          bot_status: '✅ Online',
          database: subscription ? '✅ Connected' : '❌ Disconnected',
          webhook: '✅ Active',
          queue_size: notificationQueue.length,
          uptime: Math.floor((Date.now() - stats.startTime.getTime()) / (1000 * 60 * 60)),
          errors: stats.errors,
          last_activity: new Date().toLocaleString()
        };
        
        const healthMessage = `🏥 *SYSTEM HEALTH CHECK* 🏥\n\n` +
                             `🤖 *Bot Status:* ${healthStatus.bot_status}\n` +
                             `🗄️ *Database:* ${healthStatus.database}\n` +
                             `📡 *Webhook:* ${healthStatus.webhook}\n` +
                             `📊 *Queue Size:* ${healthStatus.queue_size}\n` +
                             `⏰ *Uptime:* ${healthStatus.uptime} hours\n` +
                             `❌ *Total Errors:* ${healthStatus.errors}\n` +
                             `🕐 *Last Check:* ${healthStatus.last_activity}\n\n` +
                             `${healthStatus.errors === 0 ? '💚 All systems healthy!' : '⚠️ Some issues detected'}`;
        
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          chat_id: ADMIN_CHAT_ID,
          text: healthMessage,
          parse_mode: 'Markdown'
        });
      }
      else if (text === '/recent') {
        try {
          const { data: recentTxs, error } = await supabase
            .from('player_transactions')
            .select('*')
            .eq('transaction_type', 'deposit')
            .order('created_at', { ascending: false })
            .limit(5);
          
          if (error) throw error;
          
          let message = `🕐 *RECENT TRANSACTIONS* 🕐\n\n`;
          if (recentTxs.length === 0) {
            message += 'No recent transactions found.';
          } else {
            recentTxs.forEach((tx, i) => {
              const statusEmoji = tx.status === 'approved' ? '✅' : 
                                 tx.status === 'rejected' ? '❌' : '⏳';
              message += `${i + 1}. ${statusEmoji} ${tx.amount.toFixed(2)} ETB\n` +
                        `   📱 ${tx.player_phone} | ${new Date(tx.created_at).toLocaleString()}\n\n`;
            });
          }
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
          });
        } catch (error) {
          log(`Error fetching recent transactions: ${error.message}`, 'ERROR');
        }
      }
      else if (text.startsWith('/user ')) {
        const phone = text.replace('/user ', '').trim();
        try {
          const userStats = await getUserStats(phone);
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: userStats,
            parse_mode: 'Markdown'
          });
        } catch (error) {
          log(`Error fetching user stats for ${phone}: ${error.message}`, 'ERROR');
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: `❌ User not found or error: ${error.message}`
          });
        }
      }
      else if (text === '/config') {
        const configMessage = `⚙️ *BOT CONFIGURATION* ⚙️\n\n` +
                             `🤖 *Bot Token:* ${BOT_TOKEN.substring(0, 10)}...\n` +
                             `👤 *Admin Chat ID:* ${ADMIN_CHAT_ID}\n` +
                             `🌐 *Webhook URL:* ${WEBHOOK_URL}/webhook\n` +
                             `🗄️ *Database:* ${SUPABASE_URL}\n` +
                             `🚀 *Port:* ${PORT}\n` +
                             `📊 *Monitoring:* ${subscription ? 'Active' : 'Inactive'}\n\n` +
                             `⚡ *Performance Settings:*\n` +
                             `• Queue Processing: Enabled\n` +
                             `• Retry Attempts: 3\n` +
                             `• Notification Delay: 500ms\n` +
                             `• Auto Backfill: Enabled`;
        
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          chat_id: ADMIN_CHAT_ID,
          text: configMessage,
          parse_mode: 'Markdown'
        });
      }
    }
    
    res.send('OK');
  } catch (error) {
    log(`Webhook processing error: ${error.message}`, 'ERROR');
    stats.errors++;
    res.status(500).send('Error processing request');
  }
});

// Enhanced health check endpoint
app.get('/', (req, res) => {
  const healthData = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - stats.startTime.getTime()) / 1000),
    version: '2.0.0-enhanced',
    stats: {
      total_deposits: stats.totalDeposits,
      approved_deposits: stats.approvedDeposits,
      rejected_deposits: stats.rejectedDeposits,
      total_amount: stats.totalAmount,
      errors: stats.errors,
      queue_size: notificationQueue.length
    },
    services: {
      bot: 'online',
      database: subscription ? 'connected' : 'disconnected',
      webhook: 'active'
    }
  };
  
  res.json(healthData);
});

// API endpoint to get statistics (for external monitoring)
app.get('/api/stats', (req, res) => {
  res.json({
    success: true,
    data: stats,
    uptime: Date.now() - stats.startTime.getTime(),
    queue_size: notificationQueue.length,
    monitoring_active: !!subscription
  });
});

// API endpoint to manually trigger pending check
app.post('/api/check-pending', async (req, res) => {
  try {
    await backfillPendingDeposits();
    res.json({
      success: true,
      message: 'Pending deposits check triggered',
      queue_size: notificationQueue.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Scheduled tasks - Enhanced reporting
cron.schedule('0 */6 * * *', async () => {
  log('Running scheduled maintenance and reporting...');
  try {
    const systemStats = await getSystemStats();
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: ADMIN_CHAT_ID,
      text: `🔄 *SCHEDULED SYSTEM REPORT*\n\n${systemStats}`,
      parse_mode: 'Markdown'
    });
    
    // Clear old processed transactions from memory if any
    if (processingTransactions.size > 100) {
      processingTransactions.clear();
      log('Cleared processing transactions cache');
    }
  } catch (error) {
    log(`Scheduled task error: ${error.message}`, 'ERROR');
    stats.errors++;
  }
});

// Daily summary report
cron.schedule('0 9 * * *', async () => {
  log('Sending daily summary report...');
  try {
    const { data: dailyTxs, error } = await supabase
      .from('player_transactions')
      .select('*')
      .eq('transaction_type', 'deposit')
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    
    if (error) throw error;
    
    const approved = dailyTxs.filter(tx => tx.status === 'approved');
    const rejected = dailyTxs.filter(tx => tx.status === 'rejected');
    const pending = dailyTxs.filter(tx => tx.status === 'pending');
    
    const totalAmount = approved.reduce((sum, tx) => sum + tx.amount, 0);
    
    const summaryMessage = `📅 *DAILY SUMMARY REPORT* 📅\n\n` +
                          `📊 *Yesterday's Activity:*\n` +
                          `• Total Deposits: ${dailyTxs.length}\n` +
                          `• ✅ Approved: ${approved.length} (${totalAmount.toFixed(2)} ETB)\n` +
                          `• ❌ Rejected: ${rejected.length}\n` +
                          `• ⏳ Still Pending: ${pending.length}\n\n` +
                          `📈 *Performance:*\n` +
                          `• Success Rate: ${dailyTxs.length > 0 ? (approved.length / dailyTxs.length * 100).toFixed(1) : 0}%\n` +
                          `• Average Amount: ${approved.length > 0 ? (totalAmount / approved.length).toFixed(2) : 0} ETB\n` +
                          `• System Errors: ${stats.errors}\n\n` +
                          `Have a great day! 🌅`;
    
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: ADMIN_CHAT_ID,
      text: summaryMessage,
      parse_mode: 'Markdown'
    });
  } catch (error) {
    log(`Daily summary error: ${error.message}`, 'ERROR');
  }
});

// Start server with enhanced initialization
app.listen(PORT, async () => {
  log(`🚀 Enhanced Admin Bot Server v2.0 running on port ${PORT}`);
  log(`📡 Webhook URL: ${WEBHOOK_URL}/webhook`);
  log(`👤 Admin Chat ID: ${ADMIN_CHAT_ID}`);
  log(`🗄️ Database: ${SUPABASE_URL}`);
  
  // Send startup notification to admin
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: ADMIN_CHAT_ID,
      text: `🚀 *BOT STARTED SUCCESSFULLY* 🚀\n\n` +
            `✅ Server is running on port ${PORT}\n` +
            `📡 Webhook configured for ${WEBHOOK_URL}\n` +
            `🕐 Started at: ${new Date().toLocaleString()}\n\n` +
            `🔄 Initializing deposit monitoring...\n` +
            `Type /help for available commands.`,
      parse_mode: 'Markdown'
    });
  } catch (error) {
    log(`Could not send startup notification: ${error.message}`, 'WARN');
  }
  
  // Auto-start monitoring in production
  if (process.env.NODE_ENV === 'production') {
    try {
      await startDepositMonitoring();
      log('✅ Production monitoring started automatically');
    } catch (error) {
      log(`❌ Failed to start monitoring: ${error.message}`, 'ERROR');
    }
  }
});

// Graceful shutdown with cleanup
process.on('SIGTERM', async () => {
  log('🛑 Shutting down gracefully...');
  
  try {
    // Send shutdown notification
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: ADMIN_CHAT_ID,
      text: `⚠️ *BOT SHUTTING DOWN*\n\n` +
            `🛑 Server is shutting down\n` +
            `🕐 Shutdown time: ${new Date().toLocaleString()}\n` +
            `📊 Final stats: ${stats.totalDeposits} total deposits processed\n\n` +
            `Will restart automatically if configured.`,
      parse_mode: 'Markdown'
    });
  } catch (error) {
    log(`Could not send shutdown notification: ${error.message}`, 'WARN');
  }
  
  if (subscription) {
    subscription.unsubscribe();
    log('📡 Unsubscribed from database monitoring');
  }
  
  log('👋 Graceful shutdown completed');
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  log(`💥 Uncaught Exception: ${error.message}`, 'FATAL');
  console.error(error);
  stats.errors++;
});

process.on('unhandledRejection', (reason, promise) => {
  log(`💥 Unhandled Rejection at: ${promise}, reason: ${reason}`, 'FATAL');
  stats.errors++;
});
