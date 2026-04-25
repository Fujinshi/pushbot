const axios = require('axios');
const AdmZip = require('adm-zip');

// Environment variables
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// Pending upload storage
let pendingUploads = new Map();

// Helper: Send message to Telegram
async function sendMessage(chatId, text, replyToMessageId = null) {
  try {
    const payload = {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML'
    };
    if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;
    
    await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
  } catch (error) {
    console.error('Error sending message:', error.message);
  }
}

// Helper: Send action
async function sendChatAction(chatId, action = 'typing') {
  try {
    await axios.post(`${TELEGRAM_API}/sendChatAction`, {
      chat_id: chatId,
      action: action
    });
  } catch (error) {
    console.error('Error sending chat action:', error.message);
  }
}

// GitHub API helper
const githubApi = axios.create({
  baseURL: 'https://api.github.com',
  headers: {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json'
  }
});

// Create repository
async function createRepository(chatId, repoName, description = '', isPrivate = false) {
  try {
    const response = await githubApi.post('/user/repos', {
      name: repoName,
      description: description,
      private: isPrivate,
      auto_init: true
    });
    
    const repoUrl = response.data.html_url;
    await sendMessage(chatId, `✅ Repository <b>${repoName}</b> berhasil dibuat!\n\n🔗 URL: ${repoUrl}\n🔒 Private: ${isPrivate ? 'Ya' : 'Tidak'}`);
    return true;
  } catch (error) {
    let errorMsg = `❌ Gagal membuat repository: ${repoName}\n`;
    if (error.response?.data?.errors) {
      errorMsg += error.response.data.errors.map(e => e.message).join(', ');
    } else if (error.response?.data?.message) {
      errorMsg += error.response.data.message;
    } else {
      errorMsg += error.message;
    }
    await sendMessage(chatId, errorMsg);
    return false;
  }
}

// Delete repository
async function deleteRepository(chatId, repoName) {
  try {
    await githubApi.delete(`/repos/${GITHUB_USERNAME}/${repoName}`);
    await sendMessage(chatId, `✅ Repository <b>${repoName}</b> berhasil dihapus!`);
    return true;
  } catch (error) {
    let errorMsg = `❌ Gagal menghapus repository: ${repoName}\n`;
    if (error.response?.data?.message) {
      errorMsg += error.response.data.message;
    } else {
      errorMsg += error.message;
    }
    await sendMessage(chatId, errorMsg);
    return false;
  }
}

// Update repository
async function updateRepository(chatId, repoName, newName = null, newDescription = null, newPrivate = null) {
  try {
    const updateData = {};
    if (newName) updateData.name = newName;
    if (newDescription) updateData.description = newDescription;
    if (newPrivate !== null) updateData.private = newPrivate;
    
    const response = await githubApi.patch(`/repos/${GITHUB_USERNAME}/${repoName}`, updateData);
    
    let message = `✅ Repository <b>${repoName}</b> berhasil diupdate!\n\n`;
    if (newName) message += `📝 Nama baru: ${newName}\n`;
    if (newDescription) message += `📄 Deskripsi baru: ${newDescription}\n`;
    if (newPrivate !== null) message += `🔒 Private: ${newPrivate ? 'Ya' : 'Tidak'}\n`;
    message += `🔗 URL: ${response.data.html_url}`;
    
    await sendMessage(chatId, message);
    return true;
  } catch (error) {
    let errorMsg = `❌ Gagal mengupdate repository: ${repoName}\n`;
    if (error.response?.data?.message) {
      errorMsg += error.response.data.message;
    } else {
      errorMsg += error.message;
    }
    await sendMessage(chatId, errorMsg);
    return false;
  }
}

// Upload single file
async function uploadToRepository(chatId, repoName, filePath, fileContent, branch = 'main', commitMessage = 'Upload via Telegram bot') {
  try {
    let sha = null;
    try {
      const getFileResponse = await githubApi.get(`/repos/${GITHUB_USERNAME}/${repoName}/contents/${filePath}`, {
        params: { ref: branch }
      });
      sha = getFileResponse.data.sha;
    } catch (error) {
      if (error.response?.status !== 404) {
        throw error;
      }
    }
    
    const base64Content = Buffer.isBuffer(fileContent) ? 
      fileContent.toString('base64') : 
      Buffer.from(fileContent).toString('base64');
    
    const response = await githubApi.put(`/repos/${GITHUB_USERNAME}/${repoName}/contents/${filePath}`, {
      message: commitMessage,
      content: base64Content,
      branch: branch,
      sha: sha
    });
    
    return response.data.content.html_url;
  } catch (error) {
    throw error;
  }
}

// Extract and upload ZIP file
async function extractAndUploadZip(chatId, repoName, zipBuffer, targetPath = '', branch = 'main', commitMessage = 'Extract ZIP via Telegram bot') {
  try {
    const zip = new AdmZip(zipBuffer);
    const zipEntries = zip.getEntries();
    
    let successCount = 0;
    let failCount = 0;
    const failedFiles = [];
    
    await sendMessage(chatId, `📦 Mengekstrak ZIP: ${zipEntries.length} file/folder ditemukan...`);
    
    for (const entry of zipEntries) {
      if (entry.isDirectory) continue;
      
      let filePath = targetPath ? `${targetPath}/${entry.entryName}` : entry.entryName;
      filePath = filePath.replace(/\\/g, '/');
      
      const fileContent = entry.getData();
      
      try {
        let sha = null;
        try {
          const getFileResponse = await githubApi.get(`/repos/${GITHUB_USERNAME}/${repoName}/contents/${filePath}`, {
            params: { ref: branch }
          });
          sha = getFileResponse.data.sha;
        } catch (error) {
          // File doesn't exist, continue
        }
        
        await githubApi.put(`/repos/${GITHUB_USERNAME}/${repoName}/contents/${filePath}`, {
          message: `${commitMessage} - ${entry.entryName}`,
          content: fileContent.toString('base64'),
          branch: branch,
          sha: sha
        });
        
        successCount++;
        
        if (successCount % 10 === 0) {
          await sendMessage(chatId, `📤 Progress: ${successCount}/${zipEntries.length} file terupload...`);
        }
        
      } catch (error) {
        failCount++;
        failedFiles.push(entry.entryName);
        console.error(`Failed to upload ${entry.entryName}:`, error.message);
      }
    }
    
    let resultMessage = `✅ Selesai! ${successCount} file berhasil diupload, ${failCount} file gagal.\n📁 Repository: ${repoName}\n📂 Target path: ${targetPath || '/'}`;
    
    if (failedFiles.length > 0 && failedFiles.length <= 5) {
      resultMessage += `\n\n❌ Gagal upload:\n${failedFiles.map(f => `- ${f}`).join('\n')}`;
    } else if (failedFiles.length > 5) {
      resultMessage += `\n\n❌ ${failedFiles.length} file gagal diupload (mungkin terlalu besar atau rate limit)`;
    }
    
    await sendMessage(chatId, resultMessage);
    
  } catch (error) {
    await sendMessage(chatId, `❌ Gagal mengekstrak ZIP: ${error.message}`);
    throw error;
  }
}

// Download file from Telegram
async function downloadTelegramFile(fileId) {
  try {
    const fileResponse = await axios.get(`${TELEGRAM_API}/getFile`, {
      params: { file_id: fileId }
    });
    
    const filePath = fileResponse.data.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
    
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    return response.data;
  } catch (error) {
    console.error('Error downloading file:', error.message);
    throw error;
  }
}

// List repositories
async function listRepositories(chatId, page = 1) {
  try {
    const response = await githubApi.get('/user/repos', {
      params: {
        sort: 'updated',
        direction: 'desc',
        per_page: 10,
        page: page
      }
    });
    
    const repos = response.data;
    if (repos.length === 0) {
      await sendMessage(chatId, '📭 Tidak ada repository ditemukan.');
      return;
    }
    
    let message = '📚 <b>Daftar Repository:</b>\n\n';
    repos.forEach((repo, index) => {
      message += `${index + 1}. <b>${repo.name}</b>\n`;
      message += `   📝 ${repo.description || 'Tidak ada deskripsi'}\n`;
      message += `   🔒 ${repo.private ? 'Private' : 'Public'}\n`;
      message += `   📅 Updated: ${new Date(repo.updated_at).toLocaleDateString()}\n`;
      message += `   🔗 ${repo.html_url}\n\n`;
    });
    
    if (repos.length === 10) {
      message += `\n📌 Gunakan /list ${page + 1} untuk halaman berikutnya`;
    }
    
    await sendMessage(chatId, message);
  } catch (error) {
    let errorMsg = '❌ Gagal mengambil daftar repository\n';
    if (error.response?.data?.message) {
      errorMsg += error.response.data.message;
    } else {
      errorMsg += error.message;
    }
    await sendMessage(chatId, errorMsg);
  }
}

// Handle commands
async function handleCommand(chatId, text, messageId) {
  const parts = text.split(' ');
  const command = parts[0].toLowerCase();
  
  // Handle /list with page number
  if (command === '/list' && parts[1]) {
    const page = parseInt(parts[1]) || 1;
    await sendChatAction(chatId);
    await listRepositories(chatId, page);
    return;
  }
  
  switch (command) {
    case '/start':
      await sendMessage(chatId, `🤖 <b>GitHub Repository Manager Bot</b>\n\n`
        + `📋 <b>Daftar Perintah:</b>\n\n`
        + `🔹 <b>Repository Management:</b>\n`
        + `/create <nama> [deskripsi] [private] - Buat repository\n`
        + `/delete <nama> - Hapus repository\n`
        + `/update <nama> -update nama:<new> desc:"text" private:true/false - Update repo\n`
        + `/list [page] - Lihat daftar repository\n\n`
        + `🔹 <b>File Management:</b>\n`
        + `/upload <repo> <path> [message] - Upload file biasa\n`
        + `/upload-zip <repo> <path> [message] - Upload & extract ZIP\n\n`
        + `/help - Bantuan lengkap`);
      break;
      
    case '/help':
      await sendMessage(chatId, `📖 <b>Panduan Lengkap Bot</b>\n\n`
        + `<b>1. MEMBUAT REPOSITORY</b>\n`
        + `/create nama_repo "deskripsi" private\n`
        + `Contoh: /create my-app "Aplikasi keren" private\n\n`
        
        + `<b>2. MENGHAPUS REPOSITORY</b>\n`
        + `/delete nama_repo\n`
        + `Contoh: /delete my-app\n\n`
        
        + `<b>3. UPDATE REPOSITORY</b>\n`
        + `/update nama_repo -update nama:baru desc:"deskripsi" private:true\n`
        + `Contoh: /update old-app -update nama:new-app desc:"Updated" private:false\n\n`
        
        + `<b>4. UPLOAD FILE BIASA</b>\n`
        + `/upload nama_repo path/file.txt "commit message"\n`
        + `Lalu kirim file\n\n`
        
        + `<b>5. UPLOAD & EXTRACT ZIP</b>\n`
        + `/upload-zip nama_repo target/path "commit message"\n`
        + `Lalu kirim file ZIP - akan otomatis extract semua file\n`
        + `Contoh: /upload-zip my-project src/ "Extract source code"\n\n`
        
        + `<b>6. LIHAT DAFTAR REPOSITORY</b>\n`
        + `/list - Halaman 1\n`
        + `/list 2 - Halaman berikutnya\n\n`
        
        + `⚠️ <b>Catatan:</b>\n`
        + `• File ZIP akan diekstrak otomatis dengan struktur folder\n`
        + `• Maksimal 100 file per ZIP untuk menghindari timeout\n`
        + `• File yang sudah ada akan di-overwrite`);
      break;
      
    case '/create':
      if (parts.length < 2) {
        await sendMessage(chatId, '⚠️ Gunakan: /create <nama_repo> [deskripsi] [private]');
        break;
      }
      const repoName = parts[1];
      let description = '';
      let isPrivate = false;
      
      if (parts.length >= 3) {
        const lastPart = parts[parts.length - 1].toLowerCase();
        if (lastPart === 'private') {
          isPrivate = true;
          description = parts.slice(2, -1).join(' ');
        } else {
          description = parts.slice(2).join(' ');
        }
      }
      
      await sendChatAction(chatId);
      await createRepository(chatId, repoName, description, isPrivate);
      break;
      
    case '/delete':
      if (parts.length < 2) {
        await sendMessage(chatId, '⚠️ Gunakan: /delete <nama_repo>');
        break;
      }
      await sendChatAction(chatId);
      await deleteRepository(chatId, parts[1]);
      break;
      
    case '/update':
      if (parts.length < 3) {
        await sendMessage(chatId, '⚠️ Gunakan: /update <nama_repo> -update nama:new desc:"text" private:true/false');
        break;
      }
      const repoToUpdate = parts[1];
      const updateFlags = parts.slice(2).join(' ');
      
      let newName = null;
      let newDesc = null;
      let newPrivate = null;
      
      const nameMatch = updateFlags.match(/nama:([^\s]+)/);
      const descMatch = updateFlags.match(/desc:"([^"]+)"/);
      const privateMatch = updateFlags.match(/private:(true|false)/);
      
      if (nameMatch) newName = nameMatch[1];
      if (descMatch) newDesc = descMatch[1];
      if (privateMatch) newPrivate = privateMatch[1] === 'true';
      
      if (!newName && !newDesc && newPrivate === null) {
        await sendMessage(chatId, '⚠️ Tidak ada perubahan yang ditentukan');
        break;
      }
      
      await sendChatAction(chatId);
      await updateRepository(chatId, repoToUpdate, newName, newDesc, newPrivate);
      break;
      
    case '/upload':
    case '/upload-zip':
      if (parts.length < 3) {
        await sendMessage(chatId, `⚠️ Gunakan: ${command} <nama_repo> <path_file> [commit_message]`);
        break;
      }
      
      const isExtractZip = command === '/upload-zip';
      const targetRepo = parts[1];
      const filePath = parts[2];
      const commitMsg = parts.slice(3).join(' ') || `Upload via Telegram bot (${isExtractZip ? 'ZIP extract' : 'file'})`;
      
      pendingUploads.set(chatId.toString(), {
        targetRepo,
        filePath,
        commitMsg,
        extractZip: isExtractZip
      });
      
      if (isExtractZip) {
        await sendMessage(chatId, `📦 <b>Mode: Extract ZIP</b>\n\n`
          + `Repository: <b>${targetRepo}</b>\n`
          + `Target path: <b>${filePath || '/'}</b>\n`
          + `Commit: ${commitMsg}\n\n`
          + `⚠️ Silakan kirim <b>file ZIP</b> yang akan diekstrak.\n`
          + `📁 Struktur folder dalam ZIP akan dipertahankan.`);
      } else {
        await sendMessage(chatId, `📤 <b>Mode: Upload File Biasa</b>\n\n`
          + `Repository: <b>${targetRepo}</b>\n`
          + `File path: <b>${filePath}</b>\n`
          + `Commit: ${commitMsg}\n\n`
          + `📎 Silakan kirim file yang akan diupload.`);
      }
      break;
      
    case '/list':
      await sendChatAction(chatId);
      await listRepositories(chatId, 1);
      break;
      
    default:
      if (text.startsWith('/')) {
        await sendMessage(chatId, `❌ Perintah tidak dikenal: ${command}\nKetik /help untuk bantuan.`);
      }
      break;
  }
}

// Main webhook handler
module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      const update = req.body;
      
      if (update.message) {
        const message = update.message;
        const chatId = message.chat.id;
        const chatIdStr = chatId.toString();
        const text = message.text || '';
        const document = message.document;
        
        console.log(`[${new Date().toISOString()}] Message from ${chatId}: ${text || 'FILE'}`);
        
        // Check for pending upload
        if (pendingUploads.has(chatIdStr) && document) {
          const pending = pendingUploads.get(chatIdStr);
          const { targetRepo, filePath, commitMsg, extractZip } = pending;
          
          await sendChatAction(chatId);
          
          try {
            const fileContent = await downloadTelegramFile(document.file_id);
            const isZipFile = document.file_name && document.file_name.endsWith('.zip');
            
            if (extractZip && isZipFile) {
              await sendMessage(chatId, `🔄 Mengekstrak dan mengupload file ZIP ke ${targetRepo}...`);
              await extractAndUploadZip(chatId, targetRepo, fileContent, filePath, 'main', commitMsg);
            } else if (extractZip && !isZipFile) {
              await sendMessage(chatId, `⚠️ Command /upload-zip membutuhkan file ZIP, tapi file yang dikirim bukan ZIP.\nFile akan diupload biasa.`);
              const uploadUrl = await uploadToRepository(chatId, targetRepo, filePath, fileContent, 'main', commitMsg);
              await sendMessage(chatId, `✅ File <b>${filePath}</b> berhasil diupload!\n🔗 ${uploadUrl}`);
            } else {
              const uploadUrl = await uploadToRepository(chatId, targetRepo, filePath, fileContent, 'main', commitMsg);
              await sendMessage(chatId, `✅ File <b>${filePath}</b> berhasil diupload!\n🔗 ${uploadUrl}`);
            }
          } catch (error) {
            await sendMessage(chatId, `❌ Gagal memproses file: ${error.message}`);
          } finally {
            pendingUploads.delete(chatIdStr);
          }
        } else if (document && !pendingUploads.has(chatIdStr)) {
          await sendMessage(chatId, `⚠️ Gunakan perintah /upload atau /upload-zip terlebih dahulu untuk menentukan tujuan upload.`);
        } else if (text) {
          await handleCommand(chatId, text, message.message_id);
        }
      }
      
      res.status(200).json({ status: 'ok' });
    } catch (error) {
      console.error('Error processing update:', error);
      res.status(200).json({ status: 'error', message: error.message });
    }
  } else if (req.method === 'GET') {
    // Setup webhook
    const webhookUrl = `https://${req.headers.host}/api/webhook`;
    try {
      const response = await axios.post(`${TELEGRAM_API}/setWebhook`, {
        url: webhookUrl
      });
      res.status(200).json({ 
        status: 'ok', 
        message: 'Webhook set', 
        webhook_url: webhookUrl,
        telegram_response: response.data 
      });
    } catch (error) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  } else {
    res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }
};
