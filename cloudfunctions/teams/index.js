// 组队管理云函数
// action: create | join | leave | bind | getMy | getMembers | refreshCode

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const COLLECTIONS = {
  TEAMS: 'teams',
  MEMBERS: 'teamMembers',
  USERS: 'users',
  ITEMS: 'items'
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
      case 'bind':
        return await bindTeam(openid, event.teamId) // teamId 为 null 表示绑定个人
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

  // 更新用户表：加入队伍并绑定
  await upsertUser(openid, {
    teamIds: _.addToSet(teamId),
    boundGroupId: teamId,
    updatedAt: new Date().toISOString()
  })

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

  // 更新用户表：加入队伍（不自动绑定，保持原有绑定不变）
  await upsertUser(openid, {
    teamIds: _.addToSet(team.teamId),
    updatedAt: new Date().toISOString()
  })

  return {
    code: 0,
    data: { teamId: team.teamId, name: team.name }
  }
}

// --- 退出队伍 ---
async function leaveTeam(openid, teamId) {
  if (!teamId) {
    return { code: -1, msg: '缺少队伍 ID' }
  }

  // 查找该用户在队伍中创建的所有物品
  const itemsRes = await db.collection(COLLECTIONS.ITEMS)
    .where({ _openid: openid, groupId: teamId })
    .get()

  // 复制物品给队伍（副本 _openid 标记为 team:xxx，groupId 保留）
  for (const item of itemsRes.data) {
    const { _id, ...itemData } = item
    await db.collection(COLLECTIONS.ITEMS).add({
      data: {
        ...itemData,
        _openid: 'team:' + teamId, // 标记为队伍副本
        id: Date.now().toString() + '_' + randomStr(4), // 新 ID
        createdAt: new Date().toISOString()
      }
    })
  }

  // 将原件移回个人空间（移除 groupId）
  for (const item of itemsRes.data) {
    await db.collection(COLLECTIONS.ITEMS)
      .doc(item._id)
      .update({ data: { groupId: _.remove() } })
  }

  // 移除成员记录
  const memberRes = await db.collection(COLLECTIONS.MEMBERS)
    .where({ teamId, openid })
    .get()

  if (memberRes.data.length > 0) {
    await db.collection(COLLECTIONS.MEMBERS).doc(memberRes.data[0]._id).remove()
  }

  // 更新用户表：移除队伍，清理绑定
  const userRes = await db.collection(COLLECTIONS.USERS)
    .where({ openid })
    .get()

  if (userRes.data.length > 0) {
    const user = userRes.data[0]
    const newTeamIds = (user.teamIds || []).filter(id => id !== teamId)
    const newBound = user.boundGroupId === teamId ? null : user.boundGroupId

    await db.collection(COLLECTIONS.USERS).doc(user._id).update({
      data: {
        teamIds: newTeamIds,
        boundGroupId: newBound,
        updatedAt: new Date().toISOString()
      }
    })
  }

  // 检查队伍是否还有成员，如果没有则解散（清理副本）
  const remainRes = await db.collection(COLLECTIONS.MEMBERS)
    .where({ teamId })
    .count()

  if (remainRes.total === 0) {
    // 删除队伍记录
    const teamDocs = await db.collection(COLLECTIONS.TEAMS)
      .where({ teamId })
      .get()
    if (teamDocs.data.length > 0) {
      await db.collection(COLLECTIONS.TEAMS).doc(teamDocs.data[0]._id).remove()
    }

    // 清理队伍副本
    const copies = await db.collection(COLLECTIONS.ITEMS)
      .where({ _openid: 'team:' + teamId })
      .get()
    for (const copy of copies.data) {
      await db.collection(COLLECTIONS.ITEMS).doc(copy._id).remove()
    }
  }

  return { code: 0, msg: '已退出队伍' }
}

// --- 切换绑定 ---
async function bindTeam(openid, teamId) {
  // teamId 为 null 表示绑定个人视角
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
    boundGroupId: teamId || null,
    updatedAt: new Date().toISOString()
  })

  return { code: 0, data: { boundGroupId: teamId || null } }
}

// --- 获取我的队伍列表 + 当前绑定 ---
async function getMyTeams(openid) {
  // 获取用户信息
  const userRes = await db.collection(COLLECTIONS.USERS)
    .where({ openid })
    .get()

  const user = userRes.data.length > 0 ? userRes.data[0] : null
  const teamIds = user?.teamIds || []
  const boundGroupId = user?.boundGroupId || null

  if (teamIds.length === 0) {
    return {
      code: 0,
      data: { teams: [], boundGroupId: null }
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
      isBound: boundGroupId === team.teamId
    })
  }

  return {
    code: 0,
    data: { teams, boundGroupId }
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
 */
async function upsertUser(openid, updates) {
  const existing = await db.collection(COLLECTIONS.USERS)
    .where({ openid })
    .get()

  if (existing.data.length > 0) {
    await db.collection(COLLECTIONS.USERS)
      .doc(existing.data[0]._id)
      .update({ data: updates })
  } else {
    // 首次使用：初始化用户记录
    const initData = { openid, ...updates }
    if (!initData.teamIds) initData.teamIds = []
    if (initData.boundGroupId === undefined) initData.boundGroupId = null
    await db.collection(COLLECTIONS.USERS).add({ data: initData })
  }
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
