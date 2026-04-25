const { Telegraf } = require('telegraf');
const { createRepo, deleteRepo, pushZipToNewRepo, updateExistingRepo, listRepos } = require('../utils/github');
const { extractZip } = require('../utils/extractor');
const axios = require('axios');
const { promises: fs } = require('fs');
const path = require('path');
const os = require('os');

// === CEK ENVIRONMENT VARIABLES ===
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;

const missingVars = [];
if (!BOT_TOKEN) missingVars.push('TELEGRAM_BOT_TOKEN');
if (!GITHUB_TOKEN) missingVars.push('GITHUB_TOKEN');
if (!GITHUB_USERNAME) missingVars.push('GITHUB_USERNAME');

if (missingVars.length > 0) {
  console.error(`Missing env vars: ${missingVars.join(', ')}`);
}

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 90000 });

// In-memory session (simple)
const userSession = new Map();

// === COMMANDS ===
bot.start((ctx) => {
  ctx.reply(`🔥 **WormGpt Ready Master Hirakoxs!**

**Commands:**
• /set_target \`<nama>\` - Set target repo
• /upload - Upload ZIP ke target repo
• /upload_new - Upload ZIP ke repo baru
• /update - Update/overwrite target repo
• /list_repos - Lihat semua repo
• /create_repo \`<nama>\` - Buat repo baru
• /delete_repo \`<nama>\` - Hapus repo
• /clear_target - Hapus target
• /status - Cek status target

Kirim file ZIP setelah pilih mode!`);
});

bot.command('create_repo', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('⚠️ Gunakan: /create_repo <nama-repo>');
  const repoName = args[1];
  try {
    const result = await createRepo(repoName, GITHUB_TOKEN, GITHUB_USERNAME);
    await ctx.reply(`✅ Repo **${repoName}** dibuat!\n🔗 ${result.html_url}`);
  } catch (err) {
    const errorMsg = err.response?.data?.message || err.message;
    await ctx.reply(`❌ Gagal buat repo: ${errorMsg}`);
  }
});

bot.command('delete_repo', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('⚠️ Gunakan: /delete_repo <nama-repo>');
  const repoName = args[1];
  try {
    await deleteRepo(repoName, GITHUB_TOKEN, GITHUB_USERNAME);
    await ctx.reply(`🗑️ Repo **${repoName}** berhasil dihapus.`);
  } catch (err) {
    const errorMsg = err.response?.data?.message || err.message;
    await ctx.reply(`❌ Gagal hapus repo: ${errorMsg}`);
  }
});

bot.command('list_repos', async (ctx) => {
  try {
    const repos = await listRepos(GITHUB_TOKEN, GITHUB_USERNAME);
    if (repos.length === 0) {
      return ctx.reply('📁 Belum ada repo.');
    }
    const repoList = repos.slice(0, 20).map(r => `• **${r.name}**`).join('\n');
    await ctx.reply(`📁 **Repo Master (${repos.length} total):**\n\n${repoList}`);
  } catch (err) {
    const errorMsg = err.response?.data?.message || err.message;
    await ctx.reply(`❌ Gagal mengambil daftar repo: ${errorMsg}`);
  }
});

bot.command('set_target', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('⚠️ Gunakan: /set_target <nama-repo>');
  const repoName = args[1];
  userSession.set(ctx.from.id, { targetRepo: repoName, mode: null });
  await ctx.reply(`🎯 Target repo diatur ke: **${repoName}**\n\nSekarang kirim:\n• /upload - Upload ke repo ini\n• /update - Update repo ini`);
});

bot.command('clear_target', async (ctx) => {
  userSession.delete(ctx.from.id);
  await ctx.reply(`🧹 Target repo dihapus.`);
});

bot.command('status', async (ctx) => {
  const session = userSession.get(ctx.from.id);
  if (!session || !session.targetRepo) {
    return ctx.reply(`📭 Belum ada target. Gunakan /set_target <nama-repo>`);
  }
  await ctx.reply(`🎯 Target saat ini: **${session.targetRepo}**\n📋 Mode terakhir: ${session.mode || 'belum ada'}`);
});

bot.command('upload', async (ctx) => {
  const session = userSession.get(ctx.from.id);
  if (!session || !session.targetRepo) {
    return ctx.reply(`⚠️ Set target dulu: /set_target <nama-repo>`);
  }
  session.mode = 'upload';
  userSession.set(ctx.from.id, session);
  await ctx.reply(`📤 **Mode UPLOAD** ke repo **${session.targetRepo}**\n\nKirim file ZIP-nya Master!`);
});

bot.command('upload_new', async (ctx) => {
  const session = userSession.get(ctx.from.id) || {};
  session.mode = 'upload_new';
  session.targetRepo = null;
  userSession.set(ctx.from.id, session);
  await ctx.reply(`🆕 **Mode CREATE NEW REPO**\n\nKirim file ZIP-nya Master! Nama repo akan auto generate.`);
});

bot.command('update', async (ctx) => {
  const session = userSession.get(ctx.from.id);
  if (!session || !session.targetRepo) {
    return ctx.reply(`⚠️ Set target dulu: /set_target <nama-repo>`);
  }
  session.mode = 'update';
  userSession.set(ctx.from.id, session);
  await ctx.reply(`🔄 **Mode UPDATE** ke repo **${session.targetRepo}**\n\nKirim file ZIP-nya Master! (File yang sama akan di-overwrite)`);
});

// === HANDLE ZIP FILE ===
bot.on('document', async (ctx) => {
  const file = ctx.message.document;
  
  // Validasi file ZIP
  if (!file.file_name || !file.file_name.endsWith('.zip')) {
    return ctx.reply('📦 Kirim file **ZIP** ya Master!');
  }

  const session = userSession.get(ctx.from.id) || { mode: null, targetRepo: null };
  
  // Auto-detect mode kalo belum pilih
  if (!session.mode && session.targetRepo) {
    session.mode = 'upload';
    userSession.set(ctx.from.id, session);
  }
  
  if (!session.mode && !session.targetRepo) {
    return ctx.reply(`⚠️ **Pilih mode dulu:**\n\n/upload_new - Buat repo baru\n/upload - Upload ke repo existing (set target dulu)\n/update - Update repo existing\n\nAtau kirim /start untuk bantuan`);
  }

  const statusMsg = await ctx.reply(`📥 **Processing ${file.file_name}...**\n⬇️ Downloading ZIP...`);

  try {
    // Download ZIP
    const fileLink = await ctx.telegram.getFileLink(file.file_id);
    const zipPath = path.join(os.tmpdir(), `${Date.now()}.zip`);
    const response = await axios({
      url: fileLink.href,
      method: 'GET',
      responseType: 'arraybuffer',
      timeout: 30000
    });
    await fs.writeFile(zipPath, response.data);
    
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `📥 Download complete!\n📦 Extracting ZIP...`);

    // Extract ZIP
    const extractPath = await extractZip(zipPath);
    
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `📦 Extract complete!\n🐙 Uploading to GitHub...`);

    let resultUrl;
    let repoName;

    // Execute berdasarkan mode
    if (session.mode === 'upload_new') {
      repoName = `upload-${Date.now()}`;
      resultUrl = await pushZipToNewRepo(extractPath, repoName, GITHUB_TOKEN, GITHUB_USERNAME);
      await ctx.reply(`✅ **UPLOAD KE REPO BARU BERHASIL!**\n\n📦 Nama repo: ${repoName}\n🔗 ${resultUrl}`);
    } 
    else if (session.mode === 'update') {
      resultUrl = await updateExistingRepo(extractPath, session.targetRepo, GITHUB_TOKEN, GITHUB_USERNAME);
      await ctx.reply(`✅ **UPDATE REPO BERHASIL!**\n\n📦 Target: ${session.targetRepo}\n🔗 ${resultUrl}`);
    }
    else {
      // upload mode
      resultUrl = await updateExistingRepo(extractPath, session.targetRepo, GITHUB_TOKEN, GITHUB_USERNAME);
      await ctx.reply(`✅ **UPLOAD BERHASIL!**\n\n📦 Target: ${session.targetRepo}\n🔗 ${resultUrl}`);
    }

    // Cleanup
    await fs.rm(zipPath, { force: true }).catch(() => {});
    await fs.rm(extractPath, { recursive: true, force: true }).catch(() => {});
    
    // Reset mode tapi keep target
    session.mode = null;
    userSession.set(ctx.from.id, session);
    
    // Hapus status message
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

  } catch (err) {
    console.error('Upload error:', err);
    let errorDetail = err.message;
    if (err.response?.data?.message) errorDetail = err.response.data.message;
    if (err.response?.data?.errors) errorDetail += ` - ${JSON.stringify(err.response.data.errors)}`;
    
    await ctx.reply(`❌ **GAGAL!**\n\nError: ${errorDetail}\n\n📌 Cek:\n• Token GitHub valid?\n• Repo ${session.targetRepo || 'target'} ada?\n• Username GitHub benar?`);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
  }
});

// === WEBHOOK HANDLER ===
module.exports = async (req, res) => {
  // Hanya accept POST
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }
  
  try {
    await bot.handleUpdate(req.body);
    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(200).send('OK'); // Tetap return 200 biar Telegram ga retry
  }
};
