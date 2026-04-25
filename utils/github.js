const axios = require('axios');
const { promises: fs } = require('fs');
const path = require('path');

const GITHUB_API = 'https://api.github.com';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function githubRequest(method, url, token, data = null, retryCount = 0) {
  const config = {
    method,
    url: `${GITHUB_API}${url}`,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json'
    },
    timeout: 60000
  };
  if (data) config.data = data;
  
  try {
    const response = await axios(config);
    return response.data;
  } catch (err) {
    const status = err.response?.status;
    const message = err.response?.data?.message || err.message;
    
    if ((status === 403 && message.includes('secondary rate limit')) || status === 429) {
      if (retryCount < 3) {
        const waitTime = (retryCount + 1) * 10000;
        console.log(`Rate limit, waiting ${waitTime}ms...`);
        await sleep(waitTime);
        return githubRequest(method, url, token, data, retryCount + 1);
      }
    }
    
    if (status === 409 && retryCount < 2) {
      await sleep(2000);
      return githubRequest(method, url, token, data, retryCount + 1);
    }
    
    throw err;
  }
}

async function createRepo(name, token, username) {
  const repo = await githubRequest('POST', '/user/repos', token, { name, private: false });
  await sleep(1000);
  
  // Inisialisasi repo kosong dengan commit pertama
  try {
    await initEmptyRepo(name, token, username);
  } catch (err) {
    console.log('Init empty repo warning:', err.message);
  }
  
  return repo;
}

// Fungsi baru: inisialisasi repo kosong biar gak error "empty repository"
async function initEmptyRepo(repoName, token, username) {
  // Buat blob kosong (file .gitkeep)
  const blob = await githubRequest('POST', `/repos/${username}/${repoName}/git/blobs`, token, {
    content: Buffer.from('# Empty repository initialized by Telegram bot\n').toString('base64'),
    encoding: 'base64'
  });
  
  // Buat tree
  const tree = await githubRequest('POST', `/repos/${username}/${repoName}/git/trees`, token, {
    tree: [{
      path: '.gitkeep',
      mode: '100644',
      type: 'blob',
      sha: blob.sha
    }]
  });
  
  // Buat commit
  const commit = await githubRequest('POST', `/repos/${username}/${repoName}/git/commits`, token, {
    message: 'Initial commit by Telegram bot',
    tree: tree.sha
  });
  
  // Buat branch main/master
  try {
    await githubRequest('POST', `/repos/${username}/${repoName}/git/refs`, token, {
      ref: 'refs/heads/main',
      sha: commit.sha
    });
  } catch (err) {
    // Coba pake master
    await githubRequest('POST', `/repos/${username}/${repoName}/git/refs`, token, {
      ref: 'refs/heads/master',
      sha: commit.sha
    });
  }
  
  await sleep(500);
}

async function deleteRepo(name, token, username) {
  await githubRequest('DELETE', `/repos/${username}/${name}`, token);
}

async function listRepos(token, username) {
  const repos = [];
  let page = 1;
  while (true) {
    const data = await githubRequest('GET', `/users/${username}/repos?per_page=100&page=${page}`, token);
    if (data.length === 0) break;
    repos.push(...data);
    page++;
    await sleep(500);
  }
  return repos;
}

async function getDefaultBranch(token, username, repoName) {
  try {
    const repo = await githubRequest('GET', `/repos/${username}/${repoName}`, token);
    return repo.default_branch;
  } catch {
    return 'main';
  }
}

async function uploadFilesToRepo(extractPath, repoName, token, username, isUpdate = false) {
  // Cek repo exists
  let repoExists = true;
  let isRepoEmpty = false;
  
  try {
    const repoData = await githubRequest('GET', `/repos/${username}/${repoName}`, token);
    repoExists = true;
    // Cek apakah repo kosong (belum ada commit)
    if (repoData.size === 0 || repoData.default_branch === null) {
      isRepoEmpty = true;
    }
  } catch (err) {
    repoExists = false;
    if (!isUpdate) {
      await createRepo(repoName, token, username);
      await sleep(1000);
      isRepoEmpty = true; // Repo baru pasti kosong
    } else {
      throw new Error(`Repo ${repoName} tidak ditemukan!`);
    }
  }

  const defaultBranch = await getDefaultBranch(token, username, repoName);
  
  let currentCommitSha = null;
  let currentTreeSha = null;
  
  // Jika repo kosong, skip ambil commit/tree
  if (!isRepoEmpty && repoExists && isUpdate) {
    try {
      const ref = await githubRequest('GET', `/repos/${username}/${repoName}/git/refs/heads/${defaultBranch}`, token);
      currentCommitSha = ref.object.sha;
      const commit = await githubRequest('GET', `/repos/${username}/${repoName}/git/commits/${currentCommitSha}`, token);
      currentTreeSha = commit.tree.sha;
      await sleep(500);
    } catch (err) {
      // Repo mungkin kosong atau branch belum ada
      isRepoEmpty = true;
    }
  }

  // Kumpulkan semua file
  const files = [];
  async function walkDir(dir, basePath = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.join(basePath, entry.name);
      if (entry.isDirectory()) {
        await walkDir(fullPath, relativePath);
      } else {
        const content = await fs.readFile(fullPath);
        files.push({
          path: relativePath.replace(/\\/g, '/'),
          content: content.toString('base64')
        });
      }
    }
  }
  
  await walkDir(extractPath);
  
  if (files.length === 0) {
    return `https://github.com/${username}/${repoName} (no files)`;
  }

  const blobs = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const blob = await githubRequest('POST', `/repos/${username}/${repoName}/git/blobs`, token, {
      content: file.content,
      encoding: 'base64'
    });
    blobs.push({
      path: file.path,
      mode: '100644',
      type: 'blob',
      sha: blob.sha
    });
    await sleep(200);
  }

  const treeData = { tree: blobs };
  if (currentTreeSha && !isRepoEmpty) treeData.base_tree = currentTreeSha;
  const tree = await githubRequest('POST', `/repos/${username}/${repoName}/git/trees`, token, treeData);
  await sleep(300);

  const commitData = {
    message: `${isUpdate ? 'Update' : 'Upload'} from Telegram bot - ${new Date().toISOString()}`,
    tree: tree.sha,
    parents: currentCommitSha && !isRepoEmpty ? [currentCommitSha] : []
  };
  const commit = await githubRequest('POST', `/repos/${username}/${repoName}/git/commits`, token, commitData);
  await sleep(300);

  // Update or create branch
  try {
    await githubRequest('PATCH', `/repos/${username}/${repoName}/git/refs/heads/${defaultBranch}`, token, {
      sha: commit.sha,
      force: true
    });
  } catch (err) {
    // Branch belum ada, create baru
    await githubRequest('POST', `/repos/${username}/${repoName}/git/refs`, token, {
      ref: `refs/heads/${defaultBranch}`,
      sha: commit.sha
    });
  }

  return `https://github.com/${username}/${repoName}`;
}

async function pushZipToNewRepo(extractPath, repoName, token, username) {
  return await uploadFilesToRepo(extractPath, repoName, token, username, false);
}

async function updateExistingRepo(extractPath, repoName, token, username) {
  return await uploadFilesToRepo(extractPath, repoName, token, username, true);
}

module.exports = { 
  createRepo, 
  deleteRepo, 
  listRepos,
  pushZipToNewRepo, 
  updateExistingRepo 
};
