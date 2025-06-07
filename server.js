const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
app.use(express.json());

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

if (!BOT_TOKEN || !ADMIN_CHAT_ID || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing required environment variables!");
  process.exit(1);
}

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
  lastDepositTime: null
};

// NEW: User notification preferences cache
const userNotificationPrefs = new Map();

// NEW: Transaction templates
const transactionTemplates = {
  depositApproved: (amount, balance) => 
    `✅ *Deposit Approved*\n\n` +
    `💵 Amount: ${amount.toFixed(2)} ETB\n` +
    `💰 New Balance: ${balance.toFixed(2)} ETB\n\n` +
    `Thank you for your deposit!`,
    
  depositRejected: (amount, reason) => 
    `❌ *Deposit Rejected*\n\n` +
    `💵 Amount: ${amount.toFixed(2)} ETB\n` +
    `📝 Reason: ${reason || "Not specified"}\n\n` +
    `Please contact support for more information.`
};

// Webhook setup endpoint
app.get('/set-webhook', async (req, res) => {
  try {
    const url = `${PUBLIC_URL}/webhook`;
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
  if (subscription) {
    await supabase.removeChannel(subscription);
  }
  
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
          stats.lastDepositTime = new Date();
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
      notificationQueue.unshift(deposit);
    }
  } finally {
    isProcessingQueue = false;
    if (notificationQueue.length > 0) {
      setImmediate(() => processNotificationQueue());
    }
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
  
  // NEW: Add risk score calculation
  const riskScore = await calculateRiskScore(deposit.player_phone, deposit.amount);
  const riskEmoji = riskScore < 30 ? '🟢' : riskScore < 70 ? '🟡' : '🔴';
  
  const message = `💰 *New Deposit Request* 💰\n\n` +
                 `🆔 *ID:* ${deposit.id}\n` +
                 `📱 *Phone:* ${deposit.player_phone}\n` +
                 `💵 *Amount:* ${deposit.amount.toFixed(2)} ETB\n` +
                 `${riskEmoji} *Risk Score:* ${riskScore}%\n` +
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
      { text: "📊 User Stats", callback_data: `stats_${deposit.player_phone}` },
      { text: "⚠️ Risk Analysis", callback_data: `risk_${deposit.player_phone}` }
    ]
  ];

  // Add image viewing button if image proof exists
  if (hasImageProof) {
    keyboard.push([
      { text: "📸 View Image Proof", callback_data: `image_${deposit.id}_${fileIdMatch[1]}` }
    ]);
  }

  // NEW: Add quick rejection reasons
  keyboard.push([
    { text: "🚫 No Proof", callback_data: `reject_reason_${deposit.id}_no_proof` },
    { text: "🚫 Suspicious", callback_data: `reject_reason_${deposit.id}_suspicious` }
  ]);

  try {
    await sendMessage(
      ADMIN_CHAT_ID,
      message,
      'Markdown',
      { inline_keyboard: keyboard }
    );
  } catch (error) {
    console.error('Error sending deposit notification:', error);
    throw error;
  }
}

// NEW: Risk score calculation
async function calculateRiskScore(phone, amount) {
  try {
    // Get user's transaction history
    const { data: transactions, error } = await supabase
      .from('player_transactions')
      .select('*')
      .eq('player_phone', phone);
      
    if (error) throw error;
    
    // Calculate risk factors
    const depositCount = transactions.filter(t => 
      t.transaction_type === 'deposit' && t.status === 'approved').length;
    const rejectionRate = transactions.filter(t => 
      t.transaction_type === 'deposit' && t.status === 'rejected').length / 
      (depositCount || 1);
    
    // Simple risk algorithm (can be enhanced)
    let score = 20; // Base risk
    
    // Adjust based on factors
    if (depositCount === 0) score += 30; // New user
    if (rejectionRate > 0.3) score += 20; // High rejection rate
    if (amount > 5000) score += 15; // Large amount
    if (amount > 10000) score += 15; // Very large amount
    
    // Cap at 100
    return Math.min(100, Math.max(0, score));
  } catch (error) {
    console.error('Risk calculation error:', error);
    return 50; // Default medium risk if error
  }
}

// NEW: Risk analysis report
async function getRiskAnalysis(phone) {
  const riskScore = await calculateRiskScore(phone);
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('phone', phone)
    .single();
    
  if (error) throw error;
  
  const { data: transactions } = await supabase
    .from('player_transactions')
    .select('*')
    .eq('player_phone', phone);
    
  const approvedDeposits = transactions.filter(t => 
    t.transaction_type === 'deposit' && t.status === 'approved');
  const rejectedDeposits = transactions.filter(t => 
    t.transaction_type === 'deposit' && t.status === 'rejected');
  
  return `⚠️ *Risk Analysis Report* ⚠️\n\n` +
         `📱 *Phone:* ${phone}\n` +
         `👤 *User:* ${user.username || 'N/A'}\n` +
         `📅 *Member Since:* ${new Date(user.created_at).toLocaleDateString()}\n\n` +
         `📊 *Risk Score:* ${riskScore}%\n` +
         `🔢 *Factors:*\n` +
         `• Total Deposits: ${approvedDeposits.length}\n` +
         `• Rejected Deposits: ${rejectedDeposits.length}\n` +
         `• Rejection Rate: ${(rejectedDeposits.length / (approvedDeposits.length || 1) * 100).toFixed(1)}%\n\n` +
         `💡 *Recommendation:* ${riskScore < 30 ? 'Low Risk' : riskScore < 70 ? 'Medium Risk' : 'High Risk'}`;
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
    const lastDeposit = approvedDeposits.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    const lastWithdrawal = withdrawals.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

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
           `• Net Deposit: ${(totalDeposited - totalWithdrawn).toFixed(2)} ETB\n\n` +
           `⏱ *Last Activity:*\n` +
           `• Last Deposit: ${lastDeposit ? `${lastDeposit.amount.toFixed(2)} ETB on ${new Date(lastDeposit.created_at).toLocaleString()}` : 'None'}\n` +
           `• Last Withdrawal: ${lastWithdrawal ? `${Math.abs(lastWithdrawal.amount).toFixed(2)} ETB on ${new Date(lastWithdrawal.created_at).toLocaleString()}` : 'None'}`;
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
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    if (error) throw error;

    const deposits = allTransactions.filter(tx => tx.transaction_type === 'deposit');
    const withdrawals = allTransactions.filter(tx => tx.transaction_type === 'withdrawal');
    const pendingDeposits = deposits.filter(tx => tx.status === 'pending');
    const approvedDeposits = deposits.filter(tx => tx.status === 'approved');
    const rejectedDeposits = deposits.filter(tx => tx.status === 'rejected');

    const totalDepositAmount = approvedDeposits.reduce((sum, tx) => sum + tx.amount, 0);
    const totalWithdrawalAmount = withdrawals.filter(tx => tx.status === 'approved').reduce((sum, tx) => sum + Math.abs(tx.amount), 0);

    // NEW: Calculate approval rate
    const approvalRate = approvedDeposits.length / (approvedDeposits.length + rejectedDeposits.length) * 100 || 0;

    return `📊 *System Statistics (24h)* 📊\n\n` +
           `⏰ *Uptime:* ${formatUptime()}\n` +
           `🔄 *Last Activity:* ${stats.lastDepositTime ? stats.lastDepositTime.toLocaleTimeString() : 'None'}\n\n` +
           `💰 *Deposits:*\n` +
           `• Total: ${deposits.length}\n` +
           `• Pending: ${pendingDeposits.length}\n` +
           `• Approved: ${approvedDeposits.length}\n` +
           `• Rejected: ${rejectedDeposits.length}\n` +
           `• Approval Rate: ${approvalRate.toFixed(1)}%\n` +
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

// NEW: Format uptime for display
function formatUptime() {
  const uptimeMs = Date.now() - stats.startTime.getTime();
  const hours = Math.floor(uptimeMs / (1000 * 60 * 60));
  const minutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours}h ${minutes}m`;
}

// NEW: Notify user about their transaction status
async function notifyUser(phone, message) {
  try {
    // Check if user has notification preferences
    if (!userNotificationPrefs.has(phone)) {
      const { data: user } = await supabase
        .from('users')
        .select('chat_id, notifications_enabled')
        .eq('phone', phone)
        .single();
      
      if (user) {
        userNotificationPrefs.set(phone, {
          chatId: user.chat_id,
          enabled: user.notifications_enabled
        });
      } else {
        return; // User not found
      }
    }
    
    const prefs = userNotificationPrefs.get(phone);
    if (prefs.enabled && prefs.chatId) {
      await sendMessage(prefs.chatId, message, 'Markdown');
    }
  } catch (error) {
    console.error('Error notifying user:', error);
  }
}

// Main webhook handler
app.post('/webhook', async (req, res) => {
  try {
    const update = req.body;
    console.log('Received update:', JSON.stringify(update, null, 2)); // Debug logging
    
    // Handle callback queries (button presses)
    if (update.callback_query) {
      const data = update.callback_query.data;
      const [action, ...rest] = data.split('_');
      const identifier = rest.join('_');
      
      console.log(`Processing callback: ${action} for ${identifier}`); // Debug
      
      // Handle approve/reject actions
      if (action === 'approve' || action === 'reject' || action.startsWith('reject_reason')) {
        let txId, rejectReason;
        
        if (action.startsWith('reject_reason')) {
          // Handle quick rejection reasons
          const parts = identifier.split('_');
          txId = parts[0];
          rejectReason = parts.slice(1).join(' ') || 'No reason provided';
        } else {
          txId = identifier;
        }
        
        // Prevent duplicate processing
        if (processingTransactions.has(txId)) {
          console.log(`Transaction ${txId} is already being processed`);
          await answerCallbackQuery(update.callback_query.id, 
            `Transaction is already being processed!`, true);
          return res.send('OK');
        }
        
        processingTransactions.add(txId);
        
        try {
          // Check current transaction status
          const { data: currentTx, error: txError } = await supabase
            .from('player_transactions')
            .select('status, player_phone, amount, description')
            .eq('id', txId)
            .single();
            
          if (txError || !currentTx) {
            throw new Error(txError?.message || 'Transaction not found');
          }
          
          if (currentTx.status !== 'pending') {
            await answerCallbackQuery(update.callback_query.id, 
              `Transaction already ${currentTx.status}!`, true);
            return res.send('OK');
          }
          
          const status = action === 'approve' ? 'approved' : 'rejected';
          let newBalance = null;
          
          // Update transaction status
          const updateData = { 
            status,
            processed_at: new Date().toISOString(),
            processed_by: 'Admin Bot'
          };
          
          if (rejectReason) {
            updateData.rejection_reason = rejectReason;
          }
          
          const { error: updateError } = await supabase
            .from('player_transactions')
            .update(updateData)
            .eq('id', txId);
            
          if (updateError) throw updateError;
          
          // Update statistics
          if (status === 'approved') {
            stats.approvedDeposits++;
          } else {
            stats.rejectedDeposits++;
          }
          
          // Update user balance if approved
          if (status === 'approved') {
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
                           (rejectReason ? `📝 *Reason:* ${rejectReason}\n` : '') +
                           (status === 'approved' && newBalance !== null ? 
                            `💰 *New Balance:* ${newBalance.toFixed(2)} ETB` : '');
          
          await editMessageText(
            update.callback_query.message.chat.id,
            update.callback_query.message.message_id,
            newMessage,
            { inline_keyboard: [] }
          );
          
          await answerCallbackQuery(update.callback_query.id, 
            `Transaction ${status} successfully!`, false);
          
          // NEW: Notify user about the status change
          if (status === 'approved') {
            await notifyUser(
              currentTx.player_phone,
              transactionTemplates.depositApproved(currentTx.amount, newBalance)
            );
          } else {
            await notifyUser(
              currentTx.player_phone,
              transactionTemplates.depositRejected(
                currentTx.amount,
                rejectReason || 'Not specified'
              )
            );
          }
          
        } catch (error) {
          console.error('Error processing transaction:', error);
          
          await sendMessage(
            ADMIN_CHAT_ID,
            `❌ Error processing transaction ${txId}:\n\n<code>${error.message}</code>`,
            'HTML'
          );
          
          await answerCallbackQuery(update.callback_query.id, 
            `Error: ${error.message.substring(0, 50)}...`, true);
        } finally {
          processingTransactions.delete(txId);
        }
      }
      // Handle image proof viewing
      else if (action === 'image') {
        const [txId, fileId] = identifier.split('_');
        
        try {
          // First, answer the callback query to remove loading indicator
          await answerCallbackQuery(update.callback_query.id, 
            `Fetching image proof...`, false);
            
          // Then send the image
          await sendPhoto(ADMIN_CHAT_ID, fileId, 
            `📸 *Deposit Image Proof* (TX ID: ${txId})\n\n` +
            `This is the image proof submitted by the user for their deposit request.`);
          
        } catch (error) {
          console.error('Error sending image proof:', error);
          await answerCallbackQuery(update.callback_query.id, 
            `Error loading image proof!`, true);
        }
      }
      // Handle history request
      else if (action === 'history') {
        const phone = identifier;
        
        try {
          const history = await getTransactionHistory(phone);
          
          await answerCallbackQuery(update.callback_query.id, 
            `Showing transaction history for ${phone}`, false);
          
          await sendMessage(ADMIN_CHAT_ID, history, 'Markdown');
        } catch (error) {
          console.error('Error fetching history:', error);
          await answerCallbackQuery(update.callback_query.id, 
            `Error loading history!`, true);
        }
      }
      // Handle user stats request
      else if (action === 'stats') {
        const phone = identifier;
        
        try {
          const userStats = await getUserStats(phone);
          
          await answerCallbackQuery(update.callback_query.id, 
            `Showing user statistics for ${phone}`, false);
          
          await sendMessage(ADMIN_CHAT_ID, userStats, 'Markdown');
        } catch (error) {
          console.error('Error fetching user stats:', error);
          await answerCallbackQuery(update.callback_query.id, 
            `Error loading user stats!`, true);
        }
      }
      // Handle risk analysis request
      else if (action === 'risk') {
        const phone = identifier;
        
        try {
          const riskAnalysis = await getRiskAnalysis(phone);
          
          await answerCallbackQuery(update.callback_query.id, 
            `Showing risk analysis for ${phone}`, false);
          
          await sendMessage(ADMIN_CHAT_ID, riskAnalysis, 'Markdown');
        } catch (error) {
          console.error('Error fetching risk analysis:', error);
          await answerCallbackQuery(update.callback_query.id, 
            `Error loading risk analysis!`, true);
        }
      }
    }
    
    // Handle text commands
    if (update.message && update.message.text) {
      const text = update.message.text.toLowerCase();
      const chatId = update.message.chat.id.toString();
      
      // Only respond to admin
      if (chatId !== ADMIN_CHAT_ID) {
        return res.send('OK');
      }
      
      if (text === '/stats' || text === '/statistics') {
        try {
          const systemStats = await getSystemStats();
          await sendMessage(ADMIN_CHAT_ID, systemStats, 'Markdown');
        } catch (error) {
          console.error('Error getting system stats:', error);
        }
      }
      
      if (text === '/help') {
        const helpMessage = `🤖 *Admin Bot Commands* 🤖\n\n` +
                           `📊 /stats - View system statistics\n` +
                           `❓ /help - Show this help message\n` +
                           `🔄 /restart - Restart monitoring\n` +
                           `📋 /pending - Show pending deposits\n` +
                           `👤 /user <phone> - Get user info\n` +
                           `⚠️ /risk <phone> - Get risk analysis\n\n` +
                           `*Automatic Features:*\n` +
                           `• Real-time deposit notifications\n` +
                           `• Image proof viewing\n` +
                           `• User transaction history\n` +
                           `• User statistics\n` +
                           `• Risk scoring\n` +
                           `• Quick approve/reject with reasons\n` +
                           `• User notifications`;
        
        await sendMessage(ADMIN_CHAT_ID, helpMessage, 'Markdown');
      }
      
      if (text === '/restart') {
        try {
          await startDepositMonitoring();
          await sendMessage(ADMIN_CHAT_ID, '🔄 Monitoring restarted successfully!');
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
            await sendMessage(ADMIN_CHAT_ID, '✅ No pending deposits!');
          } else {
            for (const deposit of pendingDeposits) {
              await sendDepositNotification(deposit);
            }
          }
        } catch (error) {
          console.error('Error fetching pending deposits:', error);
        }
      }
      
      // NEW: User lookup command
      if (text.startsWith('/user ')) {
        const phone = text.split(' ')[1];
        if (!phone) {
          await sendMessage(ADMIN_CHAT_ID, 'Please provide a phone number: /user +1234567890');
          return;
        }
        
        try {
          const userStats = await getUserStats(phone);
          await sendMessage(ADMIN_CHAT_ID, userStats, 'Markdown');
        } catch (error) {
          console.error('Error fetching user:', error);
          await sendMessage(ADMIN_CHAT_ID, `Error fetching user ${phone}: ${error.message}`);
        }
      }
      
      // NEW: Risk analysis command
      if (text.startsWith('/risk ')) {
        const phone = text.split(' ')[1];
        if (!phone) {
          await sendMessage(ADMIN_CHAT_ID, 'Please provide a phone number: /risk +1234567890');
          return;
        }
        
        try {
          const riskAnalysis = await getRiskAnalysis(phone);
          await sendMessage(ADMIN_CHAT_ID, riskAnalysis, 'Markdown');
        } catch (error) {
          console.error('Error fetching risk analysis:', error);
          await sendMessage(ADMIN_CHAT_ID, `Error analyzing risk for ${phone}: ${error.message}`);
        }
      }
    }
    
    res.send('OK');
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).send('Error processing request');
  }
});

// Helper functions for Telegram API
async function answerCallbackQuery(callbackQueryId, text, showAlert) {
  return axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    callback_query_id: callbackQueryId,
    text: text,
    show_alert: showAlert
  });
}

async function editMessageText(chatId, messageId, text, replyMarkup) {
  return axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: 'Markdown',
    reply_markup: replyMarkup
  });
}

async function sendMessage(chatId, text, parseMode = 'Markdown', replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: parseMode
  };
  
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }
  
  return axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, payload);
}

async function sendPhoto(chatId, photo, caption = '', parseMode = 'Markdown') {
  return axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    chat_id: chatId,
    photo: photo,
    caption: caption,
    parse_mode: parseMode
  });
}

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
