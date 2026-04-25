const { Telegraf } = require('telegraf');
const { createRepo, deleteRepo, pushZipToRepo } = require('../utils/github');
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
bot.telegram.setWebhook(process.env.VERCEL_URL + '/api/webhook');

bot.start((ctx) => ctx.reply('Halo Master! Kirim file ZIP, aku akan upload ke GitHub repo mu.'));

bot.command('create_repo', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('Gunakan: /create_repo <nama-repo>');
  const repoName = args[1];
  try {
    const result = await createRepo(repoName, GITHUB_TOKEN, GITHUB_USERNAME);
    ctx.reply(`✅ Repo ${repoName} dibuat: ${result.html_url}`);
  } catch (err) {
    ctx.reply(`❌ Gagal: ${err.message}`);
  }
});

bot.command('delete_repo', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('Gunakan: /delete_repo <nama-repo>');
  const repoName = args[1];
  try {
    await deleteRepo(repoName, GITHUB_TOKEN, GITHUB_USERNAME);
    ctx.reply(`🗑️ Repo ${repoName} berhasil dihapus.`);
  } catch (err) {
    ctx.reply(`❌ Gagal: ${err.message}`);
  }
});

bot.on('document', async (ctx) => {
  const file = ctx.message.document;
  if (!file.file_name.endsWith('.zip')) {
    return ctx.reply('Kirim file ZIP ya Master!');
  }

  await ctx.reply('📥 Download ZIP...');
  const fileLink = await ctx.telegram.getFileLink(file.file_id);
  const zipPath = path.join(os.tmpdir(), `${Date.now()}.zip`);
  const response = await axios({ url: fileLink.href, responseType: 'arraybuffer' });
  await fs.writeFile(zipPath, response.data);

  await ctx.reply('📦 Extract ZIP...');
  const extractPath = await extractZip(zipPath);

  await ctx.reply('🐙 Upload ke GitHub...');
  const repoName = `auto-upload-${Date.now()}`;
  const repoUrl = await pushZipToRepo(extractPath, repoName, GITHUB_TOKEN, GITHUB_USERNAME);

  await ctx.reply(`✅ Selesai! Repo: ${repoUrl}`);
  await fs.rm(zipPath).catch(() => {});
  await fs.rm(extractPath, { recursive: true, force: true }).catch(() => {});
});

module.exports = async (req, res) => {
  try {
    await bot.handleUpdate(req.body, res);
    res.status(200).send('OK');
  } catch (e) {
    res.status(500).send('Error');
  }
};