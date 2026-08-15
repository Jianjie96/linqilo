const app = getApp()
const syncUtil = require('../../utils/sync.js')
const shareMixin = require('../../utils/share.js')

Page({
  ...shareMixin,
  data: {
    // 用户资料
    nickName: '',
    avatarUrl: '',

    // 设置
    totalItems: 0,
    isSubscribed: false,
    isSyncing: false,
    cloudEnabled: false,
    subscribeSummary: '个人',
    aboutInfo: {
      name: '叮咚到期',
      version: '1.0.0'
    }
  },

  onLoad() {
    this.loadProfile()
    this.loadSettings()
    this.checkCloudStatus()
  },

  onShow() {
    this.loadSettings()
    this.checkSubscriptionStatus()
    this._updateSubscribeSummary()
    // 每次展示时刷新资料（可能从其他页面返回后头像/昵称已更新）
    this.loadProfile()
  },

  // --- 用户资料 ---

  async loadProfile() {
    try {
      const result = await syncUtil.getUserProfile()
      this.setData({
        nickName: result.data.nickName || '',
        avatarUrl: result.data.avatarUrl || ''
      })
    } catch (err) {
      console.error('加载用户资料失败:', err)
    }
  },

  // 选择头像
  async onChooseAvatar(e) {
    const { avatarUrl } = e.detail
    if (!avatarUrl) return

    wx.showLoading({ title: '上传中...' })
    try {
      // 上传到云存储
      const cloudPath = `avatars/${app.globalData.openid}_${Date.now()}.png`
      const uploadRes = await wx.cloud.uploadFile({
        cloudPath,
        filePath: avatarUrl
      })

      // 保存 cloud fileID 到用户资料
      await syncUtil.updateProfile(undefined, uploadRes.fileID)
      wx.hideLoading()

      // 获取临时链接用于展示
      const tempRes = await wx.cloud.getTempFileURL({ fileList: [uploadRes.fileID] })
      this.setData({
        avatarUrl: tempRes.fileList[0].tempFileURL
      })

      wx.showToast({ title: '头像已更新', icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      console.error('上传头像失败:', err)
      wx.showToast({ title: '上传失败，请重试', icon: 'none' })
    }
  },

  // 昵称输入失焦时保存
  onNicknameBlur(e) {
    const nickName = (e.detail.value || '').trim()
    if (nickName && nickName !== this.data.nickName) {
      this.saveNickname(nickName)
    }
  },

  // 昵称输入确认时保存
  onNicknameConfirm(e) {
    const nickName = (e.detail.value || '').trim()
    if (nickName && nickName !== this.data.nickName) {
      this.saveNickname(nickName)
    }
  },

  async saveNickname(nickName) {
    try {
      await syncUtil.updateProfile(nickName, undefined)
      this.setData({ nickName })
      wx.showToast({ title: '昵称已更新', icon: 'success' })
    } catch (err) {
      console.error('保存昵称失败:', err)
      wx.showToast({ title: '保存失败', icon: 'none' })
    }
  },

  // --- 设置（从旧 settings 页迁移） ---

  loadSettings() {
    this.setData({
      totalItems: app.globalData.items.length
    })
    this._updateSubscribeSummary()
  },

  _updateSubscribeSummary() {
    const { mutedGroups, teams } = app.globalData
    const muted = Array.isArray(mutedGroups) ? mutedGroups : []
    const personalOn = !muted.includes('personal')
    const teamOnCount = (teams || []).filter(t => !muted.includes(t.teamId)).length
    const total = (personalOn ? 1 : 0) + teamOnCount
    this.setData({
      subscribeSummary: total > 0 ? `订阅 ${total} 个目标` : '全部静音'
    })
  },

  goTeam() {
    wx.navigateTo({ url: '/pages/team/team' })
  },

  goHelp() {
    wx.navigateTo({ url: '/pages/help/help' })
  },

  checkCloudStatus() {
    this.setData({ cloudEnabled: !!wx.cloud })
    if (wx.cloud) {
      this.checkSubscriptionStatus()
    }
  },

  async checkSubscriptionStatus() {
    const openid = app.globalData.openid
    if (!openid || !wx.cloud) return

    try {
      const status = await syncUtil.getSubscriptionStatus(openid)
      this.setData({ isSubscribed: status.enabled })
    } catch (err) {
      console.error('查询订阅状态失败:', err)
    }
  },

  async subscribeNotification() {
    if (!wx.cloud) {
      wx.showToast({ title: '云开发未启用', icon: 'none' })
      return
    }

    wx.requestSubscribeMessage({
      tmplIds: ['68FxhLOgJgDwUZWFOZFunglKqFWCsHPq3vSwsKI9YPY'],
      success: async (res) => {
        console.log('订阅授权结果:', res)
        const openid = app.globalData.openid
        if (!openid) {
          wx.showToast({ title: '请先等待初始化完成', icon: 'none' })
          return
        }

        await syncUtil.updateSubscription(openid, true)
        this.setData({ isSubscribed: true })

        wx.showToast({ title: '已开启通知', icon: 'success' })
      },
      fail: (err) => {
        console.error('订阅授权失败:', err)
        wx.showToast({ title: '授权失败，请重试', icon: 'none' })
      }
    })
  },

  async unsubscribeNotification() {
    const openid = app.globalData.openid
    if (!openid) return

    wx.showModal({
      title: '关闭通知',
      content: '关闭后将不再收到临期提醒消息',
      success: async (res) => {
        if (res.confirm) {
          await syncUtil.updateSubscription(openid, false)
          this.setData({ isSubscribed: false })
          wx.showToast({ title: '已关闭', icon: 'success' })
        }
      }
    })
  },

  async manualSync() {
    this.setData({ isSyncing: true })
    wx.showLoading({ title: '同步中...' })

    try {
      const items = await app.loadItems()
      wx.hideLoading()
      this.setData({ isSyncing: false, totalItems: items.length })
      wx.showToast({ title: `已同步 ${items.length} 条`, icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      this.setData({ isSyncing: false })
      wx.showToast({ title: '同步失败', icon: 'none' })
    }
  },

  clearAllData() {
    wx.showModal({
      title: '清除所有数据',
      content: '此操作将删除所有物品，且不可恢复！',
      confirmColor: '#FF3B30',
      confirmText: '确认清除',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '清除中...' })
          const items = [...app.globalData.items]
          for (const item of items) {
            try {
              await app.deleteItem(item.id)
            } catch (err) {
              console.error('删除失败:', item.id, err)
            }
          }
          wx.hideLoading()
          this.setData({ totalItems: 0 })
          wx.showToast({ title: '已清除', icon: 'success' })
        }
      }
    })
  },

  exportData() {
    const items = app.globalData.items
    if (items.length === 0) {
      wx.showToast({ title: '没有数据可导出', icon: 'none' })
      return
    }

    wx.showActionSheet({
      itemList: ['分享为文本文件', '复制 JSON 到剪贴板'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.shareAsFile(items)
        } else {
          this.copyAsJSON(items)
        }
      }
    })
  },

  shareAsFile(items) {
    const now = new Date()
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

    let text = `叮咚到期 · 数据导出\n`
    text += `导出时间：${dateStr}\n`
    text += `共 ${items.length} 条记录\n`
    text += `${'─'.repeat(30)}\n\n`

    const statusMap = { safe: '正常', warning: '临期', danger: '今日到期', expired: '已过期' }
    const util = require('../../utils/util.js')

    items.forEach((item, i) => {
      const days = util.calcDaysRemaining ? util.calcDaysRemaining(item.expiryDate) : 0
      const status = util.getItemStatus ? util.getItemStatus(item.expiryDate, item.alertDays) : 'unknown'
      const statusText = statusMap[status] || '未知'

      text += `${i + 1}. ${item.name}\n`
      text += `   分类：${item.category || '未分类'}\n`
      if (item.productionDate) text += `   生产日期：${item.productionDate}\n`
      text += `   到期日期：${item.expiryDate}\n`
      if (days >= 0) text += `   剩余天数：${days} 天\n`
      text += `   状态：${statusText}\n`
      if (item.alertDays) text += `   临期提醒：到期前 ${item.alertDays} 天\n`
      text += `\n`
    })

    text += `${'─'.repeat(30)}\n`
    text += `由「叮咚到期」小程序生成`

    const fs = wx.getFileSystemManager()
    const filePath = `${wx.env.USER_DATA_PATH}/dingdong-export-${dateStr}.txt`

    try {
      fs.writeFileSync(filePath, text, 'utf8')
    } catch (err) {
      console.error('写入文件失败:', err)
      wx.showToast({ title: '生成文件失败', icon: 'none' })
      return
    }

    wx.shareFileMessage({
      filePath,
      fileName: `叮咚到期数据_${dateStr}.txt`,
      success: () => {
        wx.showToast({ title: '已生成文件，请选择发送对象', icon: 'none' })
      },
      fail: (err) => {
        console.error('分享文件失败:', err)
        if (err.errMsg && err.errMsg.includes('cancel')) return
        wx.showToast({ title: '分享失败，请重试', icon: 'none' })
      }
    })
  },

  copyAsJSON(items) {
    const text = JSON.stringify(items, null, 2)
    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showToast({ title: '已复制到剪贴板', icon: 'success' })
      }
    })
  },

  showAbout() {
    wx.showModal({
      title: '关于',
      content: '叮咚到期 v1.0.0\n\n提前记录食品、证件、物品的到期日，临期时主动通知你，重要事情不再忘。',
      showCancel: false,
      confirmText: '知道了'
    })
  }
})