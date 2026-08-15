/**
 * 云数据库操作工具
 * 
 * 所有操作通过云函数调用，Network 面板可见
 * 云函数：items（action: get | stats | add | update | delete）
 * 云函数：teams（action: create | join | leave | rename | dissolve | mute | updateView | getMy | getMembers | refreshCode）
 * 云函数：leaderboard（action: recordAdd | recordSave | recordExpired | getStats）
 */

const COLLECTION_SUBSCRIPTIONS = 'subscriptions'

// --- 通用云函数调用封装 ---

function callCloud(name, data = {}) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name,
      data,
      success: (res) => {
        if (res.result && res.result.code === 0) {
          resolve(res.result)
        } else {
          reject(new Error(res.result?.msg || '云函数调用失败'))
        }
      },
      fail: reject
    })
  })
}

// --- openid ---

function getOpenid() {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'getOpenid',
      success: (res) => resolve(res.result.openid),
      fail: (err) => reject(err)
    })
  })
}

// --- 物品 CRUD ---

// 云端文档 → 前端物品对象
function normalizeItem(doc) {
  return {
    _id: doc._id,
    id: doc.id,
    name: doc.name,
    expiryDate: doc.expiryDate,
    productionDate: doc.productionDate || '',
    alertDays: doc.alertDays || 1,
    category: doc.category || '',
    value: doc.value || 0,
    saved: doc.saved || false,
    savedAt: doc.savedAt || '',
    createdAt: doc.createdAt || '',
    groupId: doc.groupId || null
  }
}

async function fetchAllItems(groupId) {
  const result = await callCloud('items', { action: 'get', groupId, skip: 0, limit: 1000 })
  return (result.data || []).map(normalizeItem)
}

// 分页拉取物品：返回 { items, total }
async function fetchItemsPage(skip = 0, limit = 20, groupId) {
  const result = await callCloud('items', { action: 'get', groupId, skip, limit })
  return {
    items: (result.data || []).map(normalizeItem),
    total: result.total || 0
  }
}

// 拉取全量统计摘要（安全/临期/已过期/已省钱计数与价值）
async function fetchItemStats(groupId) {
  const result = await callCloud('items', { action: 'stats', groupId })
  return result.data || {}
}

async function addItemToCloud(item, groupId) {
  const result = await callCloud('items', { action: 'add', item, groupId })
  return result.data
}

async function updateCloudItem(itemId, updates, groupId) {
  await callCloud('items', { action: 'update', itemId, updates, groupId })
}

async function deleteCloudItem(itemId, groupId) {
  await callCloud('items', { action: 'delete', itemId, groupId })
}

// --- 排行榜 / 成就系统（跟随视角，混合池排名） ---
// teamId：不传或 'personal' = 个人视角；传队伍 id = 队伍视角（队内操作双写个人与队伍聚合）
// itemId：用于同一物品同类型事件去重，防止多人重复操作同一物品虚增统计

function recordAdd(teamId, itemId) {
  return callCloud('leaderboard', { action: 'recordAdd', teamId, itemId }).catch(() => {})
}

function recordSave(value, teamId, itemId) {
  return callCloud('leaderboard', { action: 'recordSave', value, teamId, itemId }).catch(() => {})
}

function recordExpired(teamId, itemId) {
  return callCloud('leaderboard', { action: 'recordExpired', teamId, itemId }).catch(() => {})
}

// 获取当前视角的统计 + 排行列表（等级/价值跟视角；「超过全网」混合池：所有个人与队伍同台排名）
function getLeaderboardStats(teamId) {
  return callCloud('leaderboard', { action: 'getStats', teamId })
}

// --- 订阅管理（保留直连数据库，频率低不影响调试） ---

async function updateSubscription(openid, enabled) {
  if (!wx.cloud || !openid) return

  const db = wx.cloud.database()
  const collection = db.collection(COLLECTION_SUBSCRIPTIONS)

  try {
    const existing = await collection.where({ openid }).get()

    if (existing.data.length > 0) {
      await collection.doc(existing.data[0]._id).update({
        data: { enabled, updatedAt: new Date().toISOString() }
      })
    } else {
      await collection.add({
        data: {
          openid,
          enabled,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      })
    }
  } catch (err) {
    console.error('更新订阅状态失败:', err)
  }
}

async function getSubscriptionStatus(openid) {
  if (!wx.cloud || !openid) return { enabled: false }

  const db = wx.cloud.database()
  const collection = db.collection(COLLECTION_SUBSCRIPTIONS)

  try {
    const res = await collection.where({ openid }).get()
    if (res.data.length > 0) {
      return { enabled: res.data[0].enabled }
    }
    return { enabled: false }
  } catch (err) {
    console.error('查询订阅状态失败:', err)
    return { enabled: false }
  }
}

// --- 组队管理 ---

function createTeam(name) {
  return callCloud('teams', { action: 'create', name })
}

function joinTeam(inviteCode) {
  return callCloud('teams', { action: 'join', inviteCode })
}

function leaveTeam(teamId) {
  return callCloud('teams', { action: 'leave', teamId })
}

function renameTeam(teamId, name) {
  return callCloud('teams', { action: 'rename', teamId, name })
}

function dissolveTeam(teamId) {
  return callCloud('teams', { action: 'dissolve', teamId })
}

// 订阅静音开关（target: 'personal' 或队伍 id；推送汇总所有未静音的订阅目标）
function muteTarget(target, muted) {
  return callCloud('teams', { action: 'mute', target, muted })
}

// 切换视角（高频，轻量同步后端，不影响订阅与推送）
function updateView(teamId) {
  return callCloud('teams', { action: 'updateView', teamId })
}

function getMyTeams() {
  return callCloud('teams', { action: 'getMy' })
}

function getTeamMembers(teamId) {
  return callCloud('teams', { action: 'getMembers', teamId })
}

function refreshInviteCode(teamId) {
  return callCloud('teams', { action: 'refreshCode', teamId })
}

module.exports = {
  getOpenid,
  fetchAllItems,
  fetchItemsPage,
  fetchItemStats,
  addItemToCloud,
  updateCloudItem,
  deleteCloudItem,
  recordAdd,
  recordSave,
  recordExpired,
  getLeaderboardStats,
  updateSubscription,
  getSubscriptionStatus,
  createTeam,
  joinTeam,
  leaveTeam,
  renameTeam,
  dissolveTeam,
  muteTarget,
  updateView,
  getMyTeams,
  getTeamMembers,
  refreshInviteCode
}
