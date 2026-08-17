const app = getApp()
const syncUtil = require('../../utils/sync.js')
const shareMixin = require('../../utils/share.js')

Page({
  ...shareMixin,
  data: {
    // 推送订阅（默认订阅个人 + 所有队伍，可单独静音）
    mutedGroups: [],
    personalMuted: false,

    // 我的队伍
    teams: [],
    hasTeams: false,

    // 创建队伍
    newTeamName: '',

    // 加入队伍
    joinCode: '',

    // 队伍详情
    showDetail: false,
    detailTeam: null,
    detailMembers: [],

    // 加载状态
    loading: true
  },

  onLoad() {
    // 剪贴板口令识别后跳转进来：自动填入邀请码并直接加入
    if (app.globalData.pendingInviteCode) {
      const code = app.globalData.pendingInviteCode
      app.globalData.pendingInviteCode = ''
      this.setData({ joinCode: code })
      this.loadData()
      // 稍等页面渲染后自动加入，省去手动点「加入」
      setTimeout(() => this.joinTeam(), 400)
      return
    }
    this.loadData()
  },

  onShow() {
    this.loadData()
  },

  async loadData() {
    this.setData({ loading: true })
    try {
      await app.loadTeamInfo()
      const { teams, mutedGroups } = app.globalData
      this.setData({
        teams,
        hasTeams: teams.length > 0,
        mutedGroups,
        personalMuted: mutedGroups.includes('personal'),
        loading: false
      })
    } catch (err) {
      console.error('加载队伍信息失败:', err)
      this.setData({ loading: false })
    }
  },

  // --- 输入绑定 ---
  onTeamNameInput(e) {
    this.setData({ newTeamName: e.detail.value })
  },

  onJoinCodeInput(e) {
    this.setData({ joinCode: e.detail.value.toUpperCase() })
  },

  // --- 创建队伍 ---
  async createTeam() {
    const name = this.data.newTeamName.trim()
    if (!name) {
      wx.showToast({ title: '请输入队伍名称', icon: 'none' })
      return
    }

    wx.showLoading({ title: '创建中...' })
    try {
      const result = await syncUtil.createTeam(name)
      wx.hideLoading()
      // 创建后视角切到新队伍方便查看；推送默认订阅该队伍，无需额外操作
      app.switchView(result.data.teamId)
      wx.showToast({ title: '创建成功', icon: 'success' })
      this.setData({ newTeamName: '' })
      await this.loadData()
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '创建失败', icon: 'none' })
    }
  },

  // --- 加入队伍 ---
  async joinTeam() {
    const code = this.data.joinCode.trim()
    if (!code) {
      wx.showToast({ title: '请输入邀请码', icon: 'none' })
      return
    }

    wx.showLoading({ title: '加入中...' })
    try {
      const result = await syncUtil.joinTeam(code)
      wx.hideLoading()
      // 加入后默认订阅该队伍推送
      wx.showToast({ title: `已加入「${result.data.name}」`, icon: 'success' })
      this.setData({ joinCode: '' })
      await this.loadData()
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '加入失败', icon: 'none' })
    }
  },

  // --- 静音开关（推送汇总所有未静音的订阅目标） ---
  async toggleMute(e) {
    const target = e.currentTarget.dataset.target
    if (!target) return

    try {
      const muted = await app.toggleMute(target)
      this.setData({
        mutedGroups: app.globalData.mutedGroups,
        personalMuted: app.globalData.mutedGroups.includes('personal'),
        teams: this.data.teams.map(t => ({
          ...t,
          isMuted: app.globalData.mutedGroups.includes(t.teamId)
        }))
      })
      wx.showToast({
        title: muted ? '已静音' : '已开启推送',
        icon: 'none'
      })
    } catch (err) {
      console.error('切换静音失败:', err)
      wx.showToast({ title: err.message || '操作失败', icon: 'none' })
    }
  },

  // --- 查看队伍详情 ---
  async showTeamDetail(e) {
    const teamId = e.currentTarget.dataset.teamId
    const team = this.data.teams.find(t => t.teamId === teamId)
    if (!team) return

    this.setData({ showDetail: true, detailTeam: team, detailMembers: [] })

    try {
      const result = await syncUtil.getTeamMembers(teamId)
      this.setData({
        detailMembers: result.data.members || [],
        detailTeam: {
          ...team,
          inviteCode: result.data.inviteCode || team.inviteCode
        }
      })
    } catch (err) {
      console.error('获取成员列表失败:', err)
    }
  },

  hideTeamDetail() {
    this.setData({ showDetail: false })
  },

  // --- 复制邀请码（仅复制 6 位码，供手动粘贴） ---
  copyInviteCode() {
    const code = this.data.detailTeam?.inviteCode
    if (!code) return

    wx.setClipboardData({
      data: code,
      success: () => {
        wx.showToast({ title: '邀请码已复制', icon: 'success' })
      }
    })
  },

  // --- 邀请好友（复制「口令」文案，含邀请码；好友打开小程序自动识别填入） ---
  inviteFriends() {
    const team = this.data.detailTeam
    const code = team?.inviteCode
    if (!code) return

    const text = `【叮咚到期】队伍邀请\nTA 邀请你加入队伍「${team.name}」\n邀请码：${code}\n复制本条消息，打开「叮咚到期」小程序即可自动填入邀请码~`
    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showToast({ title: '邀请口令已复制，发给好友吧', icon: 'none', duration: 2500 })
      }
    })
  },

  // --- 刷新邀请码 ---
  async refreshCode() {
    const teamId = this.data.detailTeam?.teamId
    if (!teamId) return

    wx.showModal({
      title: '刷新邀请码',
      content: '刷新后旧邀请码将失效，确定吗？',
      success: async (res) => {
        if (!res.confirm) return

        try {
          const result = await syncUtil.refreshInviteCode(teamId)
          wx.showToast({ title: '已刷新', icon: 'success' })

          // 更新详情中的邀请码
          this.setData({
            'detailTeam.inviteCode': result.data.inviteCode
          })
          await this.loadData()
        } catch (err) {
          wx.showToast({ title: err.message || '刷新失败', icon: 'none' })
        }
      }
    })
  },

  // --- 修改队伍名称（仅创建者；标题即输入框，失焦/回车直接保存，不再弹框） ---
  onRenameBlur(e) {
    this._saveTeamName((e.detail.value || '').trim())
  },

  onRenameConfirm(e) {
    this._saveTeamName((e.detail.value || '').trim())
  },

  async _saveTeamName(name) {
    const teamId = this.data.detailTeam?.teamId
    const oldName = this.data.detailTeam?.name
    if (!teamId) return
    if (!name) {
      wx.showToast({ title: '队伍名称不能为空', icon: 'none' })
      return
    }
    if (name === oldName) return

    wx.showLoading({ title: '保存中...' })
    try {
      await syncUtil.renameTeam(teamId, name)
      wx.hideLoading()
      wx.showToast({ title: '已修改', icon: 'success' })
      this.setData({ 'detailTeam.name': name })
      await this.loadData()
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '修改失败', icon: 'none' })
    }
  },

  // --- 解散队伍（仅创建者，极低频、强提醒：数据全部删除不可恢复） ---
  dissolveTeam() {
    const teamId = this.data.detailTeam?.teamId
    const teamName = this.data.detailTeam?.name
    if (!teamId) return

    wx.showModal({
      title: '解散队伍',
      content: `解散「${teamName}」后，队伍内的全部数据将被删除且不可恢复，所有成员的推送订阅也会随之移除。\n\n确定解散吗？`,
      confirmColor: '#FF3B30',
      confirmText: '确认解散',
      success: async (res) => {
        if (!res.confirm) return

        wx.showLoading({ title: '解散中...' })
        try {
          await syncUtil.dissolveTeam(teamId)
          wx.hideLoading()
          wx.showToast({ title: '队伍已解散', icon: 'success' })
          this.setData({ showDetail: false })
          // 视角/队伍列表/静音集合均已变化，重新同步
          await app.loadTeamInfo()
          if (app.getViewGroupId() === null) app.reloadItems()
          await this.loadData()
        } catch (err) {
          wx.hideLoading()
          wx.showToast({ title: err.message || '解散失败', icon: 'none' })
        }
      }
    })
  },

  // --- 彻底退出队伍（极低频、强提醒：数据归属队伍，退出不影响队内数据） ---
  leaveTeam() {
    const teamId = this.data.detailTeam?.teamId
    const teamName = this.data.detailTeam?.name
    if (!teamId) return

    wx.showModal({
      title: '彻底退出队伍',
      content: `退出「${teamName}」后：\n· 你在队伍内创建的数据归队伍所有，退出后留在队伍，队友可继续使用\n· 你对该队伍的操作权限将被移除\n· 若队伍只剩你一人，退出后队伍自动解散\n\n确定退出吗？`,
      confirmColor: '#FF3B30',
      confirmText: '确认退出',
      success: async (res) => {
        if (!res.confirm) return

        wx.showLoading({ title: '退出中...' })
        try {
          await syncUtil.leaveTeam(teamId)
          wx.hideLoading()
          wx.showToast({ title: '已退出', icon: 'success' })
          this.setData({ showDetail: false })
          // 视角可能被重置，重新同步并按当前视角加载物品
          await app.loadTeamInfo()
          app.reloadItems()
          await this.loadData()
        } catch (err) {
          wx.hideLoading()
          wx.showToast({ title: err.message || '退出失败', icon: 'none' })
        }
      }
    })
  }
})
