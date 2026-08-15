// 组队管理云函数
// action: create | join | leave | rename | dissolve | mute | updateView | getMy | getMembers | refreshCode

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const COLLECTIONS = {
  TEAMS: 'teams',
  MEMBERS: 'teamMembers',
  USERS: 'users',
  ITEMS: 'items',
  TEAM_STATS: 'team_stats',
  EVENTS: 'stat_events'
}

exports.main = async (event, context) => {
  const { action } = event
  const openid = cloud.getWXContext().OPENID

  try {
    switch (action) {
      case 'create':
        return await createTeam(openid, event.name)
      case 'join':
        return await joinTeam(openid, event.inviteCode)
      case 'leave':
        return await leaveTeam(openid, event.teamId)
      case 'rename':
        return await renameTeam(openid, event.teamId, event.name)
      case 'dissolve':
        return await dissolveTeam(openid, event.teamId)
      case 'mute':
        return await muteTarget(openid, event.target, !!event.muted)
      case 'updateView':
        return await updateView(openid, event.teamId) // teamId 为 null 表示个人视角（高频，轻量写库）
      case 'getMy':
        return await getMyTeams(openid)
      case 'getMembers':
        return await getTeamMembers(openid, event.teamId)
      case 'refreshCode':
        return await refreshInviteCode(openid, event.teamId)
      default:
        return { code: -1, msg: '未知操作: ' + action }
    }
  } catch (err) {
    console.error(`[teams:${action}] 失败:`, err)
    return { code: -1, msg: err.message }
  }
}

// --- 创建队伍 ---
async function createTeam(openid, name) {
  if (!name || !name.trim()) {
    return { code: -1, msg: '请输入队伍名称' }
  }

  const teamId = 'team_' + Date.now() + '_' + randomStr(6)
  const inviteCode = generateInviteCode()

  // 写入队伍表
  await db.collection(COLLECTIONS.TEAMS).add({
    data: {
      teamId,
      name: name.trim(),
      inviteCode,
      creatorOpenid: openid,
      createdAt: new Date().toISOString()
    }
  })

  // 写入成员表
  await db.collection(COLLECTIONS.MEMBERS).add({
    data: {
      teamId,
      openid,
      joinedAt: new Date().toISOString()
    }
  })

  // 更新用户表：加入队伍（默认订阅该队伍推送，无需额外操作）
  await upsertUser(openid, {
    addTeamId: teamId,
    updatedAt: new Date().toISOString()
  })

  // 初始化队伍成就聚合
  await ensureTeamStats(teamId)

  return {
    code: 0,
    data: { teamId, name: name.trim(), inviteCode }
  }
}

// --- 通过邀请码加入队伍 ---
async function joinTeam(openid, inviteCode) {
  if (!inviteCode || !inviteCode.trim()) {
    return { code: -1, msg: '请输入邀请码' }
  }

  // 查找队伍
  const teamRes = await db.collection(COLLECTIONS.TEAMS)
    .where({ inviteCode: inviteCode.trim().toUpperCase() })
    .get()

  if (teamRes.data.length === 0) {
    return { code: -1, msg: '邀请码无效' }
  }

  const team = teamRes.data[0]

  // 检查是否已是成员
  const existingMember = await db.collection(COLLECTIONS.MEMBERS)
    .where({ teamId: team.teamId, openid })
    .get()

  if (existingMember.data.length > 0) {
    return { code: -1, msg: '你已在该队伍中' }
  }

  // 加入成员表
  await db.collection(COLLECTIONS.MEMBERS).add({
    data: {
      teamId: team.teamId,
      openid,
      joinedAt: new Date().toISOString()
    }
  })

  // 更新用户表：加入队伍（默认订阅该队伍推送，无需额外操作）
  await upsertUser(openid, {
    addTeamId: team.teamId,
    updatedAt: new Date().toISOString()
  })

  // 确保队伍成就聚合存在（兼容旧队伍）
  await ensureTeamStats(team.teamId)

  return {
    code: 0,
    data: { teamId: team.teamId, name: team.name }
  }
}

// --- 退出队伍（数据归属队伍：退出不带走、不影响队伍内数据） ---
async function leaveTeam(openid, teamId) {
  if (!teamId) {
    return { code: -1, msg: '缺少队伍 ID' }
  }

  // 移除成员记录
  const memberRes = await db.collection(COLLECTIONS.MEMBERS)
    .where({ teamId, openid })
    .get()

  if (memberRes.data.length === 0) {
    return { code: -1, msg: '你不是该队伍的成员' }
  }

  await db.collection(COLLECTIONS.MEMBERS).doc(memberRes.data[0]._id).remove()

  // 更新用户表：移除队伍、重置指向该队伍的视角与订阅（数据与贡献均留在队伍）
  await resetUserOnLeave(openid, teamId)

  // 检查队伍是否还有成员，最后一人退出则队伍解散
  const remainRes = await db.collection(COLLECTIONS.MEMBERS)
    .where({ teamId })
    .count()

  if (remainRes.total === 0) {
    await cleanupTeam(teamId)
  }

  return { code: 0, msg: '已退出队伍' }
}

/**
 * 退出队伍时重置用户状态：
 * teamIds 移除该队伍；视角指向该队伍则回到个人；
 * 静音列表移除该队伍（该队伍已不可订阅）；
 * boundGroupId 为历史字段，指向该队伍时一并清理
 */
async function resetUserOnLeave(openid, teamId) {
  const userRes = await db.collection(COLLECTIONS.USERS)
    .where({ openid })
    .get()

  if (userRes.data.length === 0) return

  const user = userRes.data[0]
  const newTeamIds = (Array.isArray(user.teamIds) ? user.teamIds : []).filter(id => id !== teamId)
  const data = {
    teamIds: newTeamIds,
    mutedGroups: (Array.isArray(user.mutedGroups) ? user.mutedGroups : []).filter(t => t !== teamId),
    updatedAt: new Date().toISOString()
  }
  if (user.viewGroupId === teamId) data.viewGroupId = null
  if (user.boundGroupId === teamId) data.boundGroupId = null

  await db.collection(COLLECTIONS.USERS).doc(user._id).update({ data })
}

// --- 修改队伍名称（仅创建者） ---
async function renameTeam(openid, teamId, name) {
  if (!teamId) {
    return { code: -1, msg: '缺少队伍 ID' }
  }
  if (!name || !name.trim()) {
    return { code: -1, msg: '请输入队伍名称' }
  }

  const teamRes = await db.collection(COLLECTIONS.TEAMS)
    .where({ teamId })
    .get()

  if (teamRes.data.length === 0) {
    return { code: -1, msg: '队伍不存在' }
  }

  if (teamRes.data[0].creatorOpenid !== openid) {
    return { code: -1, msg: '只有创建者可以修改队伍名称' }
  }

  const newName = name.trim()
  await db.collection(COLLECTIONS.TEAMS)
    .doc(teamRes.data[0]._id)
    .update({ data: { name: newName, updatedAt: new Date().toISOString() } })

  return { code: 0, data: { name: newName } }
}

// --- 解散队伍（仅创建者，数据全部删除，不可恢复） ---
async function dissolveTeam(openid, teamId) {
  if (!teamId) {
    return { code: -1, msg: '缺少队伍 ID' }
  }

  const teamRes = await db.collection(COLLECTIONS.TEAMS)
    .where({ teamId })
    .get()

  if (teamRes.data.length === 0) {
    return { code: -1, msg: '队伍不存在' }
  }

  if (teamRes.data[0].creatorOpenid !== openid) {
    return { code: -1, msg: '只有创建者可以解散队伍' }
  }

  await cleanupTeam(teamId)
  return { code: 0, msg: '队伍已解散' }
}

/**
 * 解散队伍：删除队伍与成员记录、队内全部物品（数据归属队伍，随队伍销毁）、
 * 队伍成就聚合与账本事件，并重置所有成员的用户状态。
 * 供「创建者主动解散」与「最后一人退出自动解散」复用。
 */
async function cleanupTeam(teamId) {
  // 收集成员 openid（用于重置用户状态）
  const membersRes = await db.collection(COLLECTIONS.MEMBERS)
    .where({ teamId })
    .limit(1000)
    .get()
  const memberOpenids = (membersRes.data || []).map(m => m.openid)

  // 删除队伍记录与成员记录
  const teamDocs = await db.collection(COLLECTIONS.TEAMS)
    .where({ teamId })
    .get()
  for (const d of teamDocs.data) {
    await db.collection(COLLECTIONS.TEAMS).doc(d._id).remove()
  }
  for (const m of membersRes.data) {
    await db.collection(COLLECTIONS.MEMBERS).doc(m._id).remove()
  }

  // 删除队内全部物品（groupId = teamId）；兼容历史副本（_openid = 'team:xxx'）
  const itemDocs = await db.collection(COLLECTIONS.ITEMS)
    .where({ groupId: teamId })
    .limit(1000)
    .get()
  for (const d of itemDocs.data) {
    await db.collection(COLLECTIONS.ITEMS).doc(d._id).remove()
  }
  const copyDocs = await db.collection(COLLECTIONS.ITEMS)
    .where({ _openid: 'team:' + teamId })
    .limit(1000)
    .get()
  for (const d of copyDocs.data) {
    await db.collection(COLLECTIONS.ITEMS).doc(d._id).remove()
  }

  // 删除队伍成就聚合与账本事件
  const tsDocs = await db.collection(COLLECTIONS.TEAM_STATS)
    .where({ teamId })
    .get()
  for (const d of tsDocs.data) {
    await db.collection(COLLECTIONS.TEAM_STATS).doc(d._id).remove()
  }
  const evDocs = await db.collection(COLLECTIONS.EVENTS)
    .where({ teamId })
    .limit(1000)
    .get()
  for (const d of evDocs.data) {
    await db.collection(COLLECTIONS.EVENTS).doc(d._id).remove()
  }

  // 重置成员用户状态：移除队伍、视角/绑定/静音指向该队伍的均重置
  const usersRes = await db.collection(COLLECTIONS.USERS)
    .where({ openid: _.in(memberOpenids) })
    .get()
  for (const user of usersRes.data) {
    const data = {
      teamIds: (Array.isArray(user.teamIds) ? user.teamIds : []).filter(id => id !== teamId),
      mutedGroups: (Array.isArray(user.mutedGroups) ? user.mutedGroups : []).filter(t => t !== teamId),
      updatedAt: new Date().toISOString()
    }
    if (user.viewGroupId === teamId) data.viewGroupId = null
    if (user.boundGroupId === teamId) data.boundGroupId = null
    await db.collection(COLLECTIONS.USERS).doc(user._id).update({ data })
  }
}

// --- 订阅静音开关（个人 / 某支队伍，推送汇总所有未静音的订阅目标） ---
async function muteTarget(openid, target, muted) {
  if (!target) {
    return { code: -1, msg: '缺少目标' }
  }

  // 队伍目标需校验成员资格；'personal' 表示个人空间
  if (target !== 'personal') {
    const memberRes = await db.collection(COLLECTIONS.MEMBERS)
      .where({ teamId: target, openid })
      .count()
    if (memberRes.total === 0) {
      return { code: -1, msg: '你不是该队伍的成员' }
    }
  }

  const userRes = await db.collection(COLLECTIONS.USERS)
    .where({ openid })
    .get()

  let mutedGroups = []
  let userId = null
  if (userRes.data.length > 0) {
    const user = userRes.data[0]
    userId = user._id
    mutedGroups = Array.isArray(user.mutedGroups) ? user.mutedGroups : []
  }

  if (muted) {
    if (!mutedGroups.includes(target)) mutedGroups.push(target)
  } else {
    mutedGroups = mutedGroups.filter(t => t !== target)
  }

  const data = { mutedGroups, updatedAt: new Date().toISOString() }
  if (userId) {
    await db.collection(COLLECTIONS.USERS).doc(userId).update({ data })
  } else {
    await db.collection(COLLECTIONS.USERS).add({
      data: { openid, teamIds: [], boundGroupId: null, viewGroupId: null, ...data }
    })
  }

  return { code: 0, data: { mutedGroups } }
}

// --- 切换视角（高频操作，同步到后端，不影响订阅与推送） ---
async function updateView(openid, teamId) {
  // teamId 为 null 表示个人视角
  if (teamId) {
    // 校验是否为该队伍成员
    const memberRes = await db.collection(COLLECTIONS.MEMBERS)
      .where({ teamId, openid })
      .get()

    if (memberRes.data.length === 0) {
      return { code: -1, msg: '你不是该队伍的成员' }
    }
  }

  await upsertUser(openid, {
    viewGroupId: teamId || null,
    updatedAt: new Date().toISOString()
  })

  return { code: 0, data: { viewGroupId: teamId || null } }
}

// --- 获取我的队伍列表 + 静音订阅 + 当前视角 ---
async function getMyTeams(openid) {
  // 获取用户信息
  const userRes = await db.collection(COLLECTIONS.USERS)
    .where({ openid })
    .get()

  const user = userRes.data.length > 0 ? userRes.data[0] : null
  const rawTeamIds = user?.teamIds
  let teamIds = Array.isArray(rawTeamIds) ? rawTeamIds : []
  const viewGroupId = user?.viewGroupId || null
  const mutedGroups = Array.isArray(user?.mutedGroups) ? user.mutedGroups : []

  // 历史数据被污染（teamIds 为非数组）：从成员表重建并回写修复
  if (user && rawTeamIds !== undefined && !Array.isArray(rawTeamIds)) {
    const memberRes = await db.collection(COLLECTIONS.MEMBERS)
      .where({ openid })
      .get()
    teamIds = memberRes.data.map(m => m.teamId)
    await db.collection(COLLECTIONS.USERS)
      .doc(user._id)
      .update({ data: { teamIds, updatedAt: new Date().toISOString() } })
  }

  if (teamIds.length === 0) {
    return {
      code: 0,
      data: { teams: [], mutedGroups, viewGroupId: null }
    }
  }

  // 获取队伍详情
  const teamsRes = await db.collection(COLLECTIONS.TEAMS)
    .where({ teamId: _.in(teamIds) })
    .get()

  // 获取各队伍成员数
  const teams = []
  for (const team of teamsRes.data) {
    const memberCount = await db.collection(COLLECTIONS.MEMBERS)
      .where({ teamId: team.teamId })
      .count()

    teams.push({
      teamId: team.teamId,
      name: team.name,
      inviteCode: team.inviteCode,
      creatorOpenid: team.creatorOpenid,
      memberCount: memberCount.total,
      isCreator: team.creatorOpenid === openid,
      isMuted: mutedGroups.includes(team.teamId)
    })
  }

  // 视角指向的队伍已不在我的队伍列表（如已退出），回退为个人视角
  const validView = viewGroupId && teams.some(t => t.teamId === viewGroupId) ? viewGroupId : null

  return {
    code: 0,
    data: { teams, mutedGroups, viewGroupId: validView }
  }
}

// --- 获取队伍成员列表 ---
async function getTeamMembers(openid, teamId) {
  if (!teamId) {
    return { code: -1, msg: '缺少队伍 ID' }
  }

  // 校验调用者是否为成员
  const selfMember = await db.collection(COLLECTIONS.MEMBERS)
    .where({ teamId, openid })
    .get()

  if (selfMember.data.length === 0) {
    return { code: -1, msg: '你不是该队伍的成员' }
  }

  // 获取所有成员
  const membersRes = await db.collection(COLLECTIONS.MEMBERS)
    .where({ teamId })
    .get()

  // 获取队伍信息（取邀请码）
  const teamRes = await db.collection(COLLECTIONS.TEAMS)
    .where({ teamId })
    .get()

  const team = teamRes.data.length > 0 ? teamRes.data[0] : null

  return {
    code: 0,
    data: {
      teamName: team?.name || '',
      inviteCode: team?.inviteCode || '',
      members: membersRes.data.map(m => ({
        openid: m.openid,
        joinedAt: m.joinedAt,
        isSelf: m.openid === openid,
        isCreator: m.openid === team?.creatorOpenid
      }))
    }
  }
}

// --- 刷新邀请码 ---
async function refreshInviteCode(openid, teamId) {
  if (!teamId) {
    return { code: -1, msg: '缺少队伍 ID' }
  }

  // 校验是否为创建者
  const teamRes = await db.collection(COLLECTIONS.TEAMS)
    .where({ teamId })
    .get()

  if (teamRes.data.length === 0) {
    return { code: -1, msg: '队伍不存在' }
  }

  if (teamRes.data[0].creatorOpenid !== openid) {
    return { code: -1, msg: '只有创建者可以刷新邀请码' }
  }

  const newCode = generateInviteCode()

  await db.collection(COLLECTIONS.TEAMS)
    .doc(teamRes.data[0]._id)
    .update({ data: { inviteCode: newCode } })

  return { code: 0, data: { inviteCode: newCode } }
}

// --- 工具函数 ---

/**
 * 更新或创建用户记录（upsert 语义）
 * updates.addTeamId：可选，表示「把该队伍 ID 追加进 teamIds」（自动去重）。
 * 注意：不能直接用 _.addToSet 命令，创建新记录时命令对象会被原样写入，
 * 导致 teamIds 字段变成 object 类型，后续 $addToSet 更新会报错
 */
async function upsertUser(openid, updates) {
  const { addTeamId, ...rest } = updates
  const existing = await db.collection(COLLECTIONS.USERS)
    .where({ openid })
    .get()

  if (existing.data.length > 0) {
    const user = existing.data[0]
    const data = { ...rest }

    if (addTeamId) {
      // 历史数据若被污染为非数组（对象），按空数组重建
      const cur = Array.isArray(user.teamIds) ? user.teamIds : []
      data.teamIds = cur.includes(addTeamId) ? cur : cur.concat(addTeamId)
    }

    await db.collection(COLLECTIONS.USERS)
      .doc(user._id)
      .update({ data })
  } else {
    // 首次使用：初始化用户记录
    const initData = { openid, ...rest }
    initData.teamIds = addTeamId ? [addTeamId] : []
    if (initData.boundGroupId === undefined) initData.boundGroupId = null // 历史字段，已废弃（推送改为订阅集合）
    if (initData.viewGroupId === undefined) initData.viewGroupId = null
    if (initData.mutedGroups === undefined) initData.mutedGroups = []
    await db.collection(COLLECTIONS.USERS).add({ data: initData })
  }
}

/**
 * 确保队伍成就聚合记录存在（创建/加入队伍时初始化）
 */
async function ensureTeamStats(teamId) {
  const res = await db.collection(COLLECTIONS.TEAM_STATS).where({ teamId }).get()
  if (res.data.length > 0) return

  await db.collection(COLLECTIONS.TEAM_STATS).add({
    data: {
      teamId,
      totalTracked: 0,
      totalSaved: 0,
      totalSavedValue: 0,
      totalExpired: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  })
}

/**
 * 生成 6 位大写邀请码（去除易混淆字符 0/O/1/I）
 */
function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return code
}

/**
 * 生成指定长度的随机字符串
 */
function randomStr(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let str = ''
  for (let i = 0; i < len; i++) {
    str += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return str
}
