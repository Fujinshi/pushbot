const { Telegraf } = require('telegraf');
const { createRepo, deleteRepo, pushZipToNewRepo, updateExistingRepo, listRepos } = require('../utils/github');
const { extractZip } = require('../utils/extractor');
const axios = require('axios');
const { promises: fs } = require('fs');
const path = require('path');
const os = require('os');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;

if (!BOT_TOKEN || !GITHUB_TOKEN || !GITHUB_USERNAME) {
  throw new Error('Missing env vars');
}

const bot = new Telegraf(BOT_TOKEN);

// Store user's target repo (simple in-memory, better use Redis for production)
const userTargetRepo = new Map();

bot.start((ctx) => {
  ctx.reply(`🔥 Welcome Master Hirakoxs!

Commands:
/create_repo <nama> - Buat repo baru
/delete_repo <nama> - Hapus repo
/list_repos - Lihat semua repo
/set_target <nama> - Set target repo untuk upload
/upload - Upload ZIP ke target repo (set dulu dengan /set_target)
/upload_new - Upload ZIP ke repo baru (auto generate nama)
/update - Update existing repo dengan ZIP
/clear_target - Hapus target repo

Kirim file ZIP setelah pilih mode!`);
});

bot.command('create_repo', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('Gunakan: /create_repo <nama-repo>');
  const repoName = args[1];
  try {
    const result = await createRepo(repoName, GITHUB_TOKEN, GITHUB_USERNAME);
    await ctx.reply(`✅ Repo ${repoName} dibuat: ${result.html_url}`);
  } catch (err) {
    await ctx.reply(`❌ Gagal: ${err.message}`);
  }
});

bot.command('delete_repo', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('Gunakan: /delete_repo <nama-repo>');
  const repoName = args[1];
  try {
    await deleteRepo(repoName, GITHUB_TOKEN, GITHUB_USERNAME);
    await ctx.reply(`🗑️ Repo ${repoName} berhasil dihapus.`);
  } catch (err) {
    await ctx.reply(`❌ Gagal: ${err.message}`);
  }
});

bot.command('list_repos', async (ctx) => {
  try {
    const repos = await listRepos(GITHUB_TOKEN, GITHUB_USERNAME);
    const repoList = repos.map(r => `• ${r.name}`).join('\n');
    await ctx.reply(`📁 Repo Master:\n${repoList || 'Kosong'}`);
  } catch (err) {
    await ctx.reply(`❌ Gagal: ${err.message}`);
  }
});

bot.command('set_target', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('Gunakan: /set_target <nama-repo>');
  const repoName = args[1];
  userTargetRepo.set(ctx.from.id, repoName);
  await ctx.reply(`🎯 Target repo diatur ke: ${repoName}\nSekarang kirim /upload atau kirim file ZIP langsung`);
});

bot.command('upload', async (ctx) => {
  const targetRepo = userTargetRepo.get(ctx.from.id);
  if (!targetRepo) {
    return ctx.reply('⚠️ Set target dulu: /set_target <nama-repo>\nAtau pake /upload_new buat repo baru');
  }
  ctx.session = ctx.session || {};
  ctx.session.uploadMode = 'existing';
  ctx.session.targetRepo = targetRepo;
  await ctx.reply(`📤 Siap upload ke repo ${targetRepo}. Kirim file ZIP-nya Master!`);
});

bot.command('upload_new', async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.uploadMode = 'new';
  await ctx.reply(`🆕 Siap buat repo baru. Kirim file ZIP-nya Master!`);
});

bot.command('update', async (ctx) => {
  const targetRepo = userTargetRepo.get(ctx.from.id);
  if (!targetRepo) {
    return ctx.reply('⚠️ Set target dulu: /set_target <nama-repo>');
  }
  ctx.session = ctx.session || {};
  ctx.session.uploadMode = 'update';
  ctx.session.targetRepo = targetRepo;
  await ctx.reply(`🔄 Siap UPDATE repo ${targetRepo}. Kirim file ZIP-nya Master! (Akan overwrite file yang sama)`);
});

bot.command('clear_target', async (ctx) => {
  userTargetRepo.delete(ctx.from.id);
  await ctx.reply(`🧹 Target repo dihapus.`);
});

// Handle ZIP file
bot.on('document', async (ctx) => {
  const file = ctx.message.document;
  if (!file.file_name.endsWith('.zip')) {
    return ctx.reply('Kirim file ZIP ya Master!');
  }

  const mode = ctx.session?.uploadMode;
  const targetRepo = ctx.session?.targetRepo || userTargetRepo.get(ctx.from.id);

  if (!mode && !targetRepo) {
    return ctx.reply(`⚠️ Pilih mode dulu:
/upload_new - Buat repo baru
/upload - Upload ke repo existing (set target dulu)
/update - Update repo existing

Atau kirim /help untuk bantuan`);
  }

  await ctx.reply('📥 Download ZIP...');
  const fileLink = await ctx.telegram.getFileLink(file.file_id);
  const zipPath = path.join(os.tmpdir(), `${Date.now()}.zip`);
  const response = await axios({ url: fileLink.href, responseType: 'arraybuffer' });
  await fs.writeFile(zipPath, response.data);

  await ctx.reply('📦 Extract ZIP...');
  const extractPath = await extractZip(zipPath);

  let resultUrl;
  let repoName;

  try {
    if (mode === 'new' || (!mode && !targetRepo)) {
      // Create new repo
      repoName = `auto-upload-${Date.now()}`;
      resultUrl = await pushZipToNewRepo(extractPath, repoName, GITHUB_TOKEN, GITHUB_USERNAME);
      await ctx.reply(`✅ Upload ke REPO BARU selesai!\n📦 ${resultUrl}`);
    } 
    else if (mode === 'update') {
      // Update existing repo
      resultUrl = await updateExistingRepo(extractPath, targetRepo, GITHUB_TOKEN, GITHUB_USERNAME);
      await ctx.reply(`✅ UPDATE repo ${targetRepo} selesai!\n📦 ${resultUrl}`);
    }
    else {
      // Upload to existing repo
      resultUrl = await updateExistingRepo(extractPath, targetRepo, GITHUB_TOKEN, GITHUB_USERNAME);
      await ctx.reply(`✅ Upload ke ${targetRepo} selesai!\n📦 ${resultUrl}`);
    }
  } catch (err) {
    await ctx.reply(`❌ Gagal: ${err.message}`);
  }

  // Cleanup
  await fs.rm(zipPath, { force: true }).catch(() => {});
  await fs.rm(extractPath, { recursive: true, force: true }).catch(() => {});
  
  // Reset session
  ctx.session = {};
});

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }
  try {
    await bot.handleUpdate(req.body, res);
    if (!res.headersSent) {
      res.status(200).send('OK');
    }
  } catch (error) {
    console.error('Fatal error:', error);
    if (!res.headersSent) {
      res.status(500).send('Error');
    }
  }
};
