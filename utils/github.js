const axios = require('axios');
const { promises: fs } = require('fs');
const path = require('path');

const GITHUB_API = 'https://api.github.com';

async function githubRequest(method, url, token, data = null) {
  const config = {
    method,
    url: `${GITHUB_API}${url}`,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json'
    },
    timeout: 30000
  };
  if (data) config.data = data;
  
  const response = await axios(config);
  return response.data;
}

async function createRepo(name, token, username) {
  return await githubRequest('POST', '/user/repos', token, { name, private: false });
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
  try {
    await githubRequest('GET', `/repos/${username}/${repoName}`, token);
  } catch (err) {
    repoExists = false;
    if (!isUpdate) {
      await createRepo(repoName, token, username);
    } else {
      throw new Error(`Repo ${repoName} tidak ditemukan!`);
    }
  }

  const defaultBranch = await getDefaultBranch(token, username, repoName);
  
  // Dapatkan commit SHA terbaru untuk update
  let currentCommitSha = null;
  let currentTreeSha = null;
  
  if (repoExists && isUpdate) {
    try {
      const ref = await githubRequest('GET', `/repos/${username}/${repoName}/git/refs/heads/${defaultBranch}`, token);
      currentCommitSha = ref.object.sha;
      const commit = await githubRequest('GET', `/repos/${username}/${repoName}/git/commits/${currentCommitSha}`, token);
      currentTreeSha = commit.tree.sha;
    } catch (err) {
      // Branch mungkin kosong
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
    return `https://github.com/${username}/${repoName} (empty)`;
  }

  // Create blobs
  const blobs = [];
  for (const file of files) {
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
  }

  // Create tree
  const treeData = { tree: blobs };
  if (currentTreeSha) treeData.base_tree = currentTreeSha;
  const tree = await githubRequest('POST', `/repos/${username}/${repoName}/git/trees`, token, treeData);

  // Create commit
  const commitData = {
    message: `${isUpdate ? 'Update' : 'Upload'} from Telegram bot - ${new Date().toISOString()}`,
    tree: tree.sha,
    parents: currentCommitSha ? [currentCommitSha] : []
  };
  const commit = await githubRequest('POST', `/repos/${username}/${repoName}/git/commits`, token, commitData);

  // Update branch
  await githubRequest('PATCH', `/repos/${username}/${repoName}/git/refs/heads/${defaultBranch}`, token, {
    sha: commit.sha,
    force: true
  });

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
