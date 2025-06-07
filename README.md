# 🤖 Enhanced Telegram Admin Bot

A comprehensive admin bot for managing deposit approvals with image proof verification and advanced features.

## ✨ Features

### 🔥 Core Features
- **Real-time Deposit Notifications** - Instant alerts for new deposits
- **Image Proof Viewing** - View payment screenshots directly in Telegram
- **One-Click Approval/Rejection** - Quick transaction processing
- **User Statistics** - Comprehensive user analytics
- **Transaction History** - Detailed transaction logs
- **System Statistics** - Monitor bot performance and metrics

### 📊 Advanced Features
- **Auto-retry Failed Notifications** - Ensures no deposits are missed
- **Duplicate Prevention** - Prevents double-processing of transactions
- **Scheduled Reports** - Automatic system health reports every 6 hours
- **Queue Management** - Efficient processing of multiple deposits
- **Error Handling** - Comprehensive error reporting and recovery

## 🚀 Quick Setup

### 1. Environment Variables
Copy `.env.example` to `.env` and fill in your values:

```bash
BOT_TOKEN=7971577643:AAFcL38ZrahWxEyyIcz3dO4aC9yq9LTAD5M
ADMIN_CHAT_ID=your_admin_chat_id
SUPABASE_URL=https://evberyanshxxalxtwnnc.supabase.co
SUPABASE_KEY=your_supabase_key
```

### 2. Get Your Admin Chat ID
1. Message your bot
2. Visit: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
3. Find your chat ID in the response

### 3. Deploy
- **Railway**: Connect GitHub repo and deploy
- **Render**: Deploy from GitHub
- **Heroku**: Use Heroku CLI or GitHub integration

### 4. Setup Webhook
Visit: `https://your-app-url.com/set-webhook`

## 📱 Admin Commands

- `/stats` - View system statistics
- `/help` - Show help message
- `/restart` - Restart monitoring
- `/pending` - Show pending deposits

## 🔧 Button Features

### Deposit Notifications Include:
- ✅ **Approve** - Approve deposit and update balance
- ❌ **Reject** - Reject deposit request
- 📝 **View History** - Show user's transaction history
- 📊 **User Stats** - Display comprehensive user statistics
- 📸 **View Image Proof** - Display payment screenshot (if available)

## 📈 Monitoring

The bot provides comprehensive monitoring:
- Real-time deposit processing
- System uptime tracking
- Transaction statistics
- Error logging and reporting
- Queue status monitoring

## 🛡️ Security Features

- Duplicate transaction prevention
- Admin-only command access
- Secure webhook handling
- Error containment and reporting
- Transaction state management

## 📊 Statistics Tracked

- Total deposits processed
- Approval/rejection rates
- Total transaction amounts
- System uptime
- Queue performance
- User activity metrics

## 🔄 Automatic Features

- **Real-time Monitoring** - Watches for new deposits via Supabase
- **Image Proof Extraction** - Automatically detects and displays payment proofs
- **Balance Updates** - Automatically updates user balances on approval
- **Scheduled Reports** - Sends system health reports every 6 hours
- **Error Recovery** - Automatically retries failed operations

## 🚨 Error Handling

The bot includes comprehensive error handling:
- Transaction processing errors
- Network connectivity issues
- Database connection problems
- Telegram API errors
- Image proof loading failures

All errors are logged and reported to the admin chat for quick resolution.