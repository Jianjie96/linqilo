const app = getApp()
const syncUtil = require('../../utils/sync.js')
const shareMixin = require('../../utils/share.js')

Page({
  ...shareMixin,
  data: {
    // 当前绑定
    boundGroupId: null,
    boundTeamName: '个人',

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
    this.loadData()
  },

  onShow() {
    this.loadData()
  },

  async loadData() {
    this.setData({ loading: true })
    try {
      await app.loadTeamInfo()
      const { teams, boundGroupId, boundTeamName } = app.globalData
      this.setData({
        teams,
        hasTeams: teams.length > 0,
        boundGroupId,
        boundTeamName: boundTeamName || '个人',
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
      wx.showToast({ title: `已加入「${result.data.name}」`, icon: 'success' })
      this.setData({ joinCode: '' })
      await this.loadData()
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '加入失败', icon: 'none' })
    }
  },

  // --- 切换绑定 ---
  async switchBinding(e) {
    const teamId = e.currentTarget.dataset.teamId || null

    wx.showLoading({ title: '切换中...' })
    try {
      await app.switchBinding(teamId)
      wx.hideLoading()
      wx.showToast({
        title: teamId ? '已切换到队伍' : '已切换到个人',
        icon: 'success'
      })
      await this.loadData()
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '切换失败', icon: 'none' })
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

  // --- 复制邀请码 ---
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

  // --- 退出队伍 ---
  leaveTeam() {
    const teamId = this.data.detailTeam?.teamId
    const teamName = this.data.detailTeam?.name
    if (!teamId) return

    wx.showModal({
      title: '退出队伍',
      content: `退出「${teamName}」后，你在该队伍中创建的物品将复制一份留在队伍，原件回到你的个人空间。确定退出吗？`,
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
          await this.loadData()
        } catch (err) {
          wx.hideLoading()
          wx.showToast({ title: err.message || '退出失败', icon: 'none' })
        }
      }
    })
  }
})
