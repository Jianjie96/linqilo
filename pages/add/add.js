const util = require('../../utils/util.js')
const syncUtil = require('../../utils/sync.js')
const app = getApp()
const shareMixin = require('../../utils/share.js')

Page({
  ...shareMixin,
  data: {
    name: '',
    productionDate: '',
    expiryDate: '',
    shelfLife: '',
    value: '',
    category: '',
    alertDays: 1,
    customAlertDays: '',
    isCustomDays: false,
    inputMode: 'manual', // manual | photo
    ocrImagePath: '', // 拍照参考图片路径
    ocrResult: '', // OCR 识别结果文本
    isProcessing: false, // 是否正在处理 OCR
    categories: ['食品', '药品', '化妆品', '日用品', '其他'],
    categoryIndex: 4,
    useShelfLife: false, // 是否使用保质期天数来计算到期日
    isSubscribed: false,
    cloudEnabled: false
  },

  onLoad(options) {
    this.setData({
      cloudEnabled: !!wx.cloud
    })
    if (wx.cloud) {
      this.checkSubscriptionStatus()
    }
  },

  onShow() {
    if (wx.cloud) {
      this.checkSubscriptionStatus()
    }
  },

  // 检查通知订阅状态
  async checkSubscriptionStatus() {
    const openid = app.globalData.openid
    if (!openid) return
    try {
      const status = await syncUtil.getSubscriptionStatus(openid)
      this.setData({ isSubscribed: status.enabled })
    } catch (err) {
      // 静默失败
    }
  },

  // 输入物品名称
  onNameInput(e) {
    this.setData({ name: e.detail.value })
  },

  // 输入价值
  onValueInput(e) {
    this.setData({ value: e.detail.value })
  },

  // 选择生产日期
  onProductionDateChange(e) {
    const productionDate = e.detail.value
    this.setData({ productionDate })
    // 如果有保质期天数，自动计算到期日
    if (this.data.useShelfLife && this.data.shelfLife) {
      const expiryDate = util.calcExpiryFromShelfLife(productionDate, parseInt(this.data.shelfLife))
      this.setData({ expiryDate })
    }
  },

  // 选择到期日期
  onExpiryDateChange(e) {
    this.setData({ expiryDate: e.detail.value })
  },

  // 输入保质期天数
  onShelfLifeInput(e) {
    const shelfLife = e.detail.value
    this.setData({ shelfLife })
    // 如果有生产日期，自动计算到期日
    if (this.data.productionDate && shelfLife) {
      const expiryDate = util.calcExpiryFromShelfLife(this.data.productionDate, parseInt(shelfLife))
      this.setData({ expiryDate })
    }
  },

  // 切换使用保质期计算
  onToggleShelfLife() {
    this.setData({ useShelfLife: !this.data.useShelfLife })
  },

  // 选择分类
  onCategoryChange(e) {
    const index = e.detail.value
    const categoryAlertMap = [1, 7, 7, 3, 1] // 食品/药品/化妆品/日用品/其他
    this.setData({
      categoryIndex: index,
      category: this.data.categories[index],
      alertDays: categoryAlertMap[index],
      isCustomDays: false,
      customAlertDays: ''
    })
  },

  // 设置临期提醒天数
  onAlertDaysChange(e) {
    this.setData({
      alertDays: parseInt(e.currentTarget.dataset.value),
      isCustomDays: false,
      customAlertDays: ''
    })
  },

  // 切换自定义天数
  onToggleCustomDays() {
    const isCustom = !this.data.isCustomDays
    this.setData({
      isCustomDays: isCustom,
      customAlertDays: isCustom ? String(this.data.alertDays) : ''
    })
  },

  // 自定义天数输入
  onCustomAlertDaysInput(e) {
    const val = parseInt(e.detail.value)
    const customAlertDays = e.detail.value
    this.setData({
      customAlertDays,
      alertDays: isNaN(val) || val < 1 ? 1 : Math.min(val, 365)
    })
  },

  // 跳转设置页开启通知
  goSettingsForNotify() {
    wx.navigateTo({ url: '/pages/settings/settings' })
  },

  // 切换到拍照模式
  switchToPhoto() {
    this.setData({ inputMode: 'photo' })
  },

  // 切换到手动模式
  switchToManual() {
    this.setData({ inputMode: 'manual' })
  },

  // 拍照识别
  takePhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera'],
      sizeType: ['compressed'],
      success: (res) => {
        const tempFilePath = res.tempFiles[0].tempFilePath
        this.handlePhoto(tempFilePath)
      }
    })
  },

  // 从相册选择
  chooseFromAlbum() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album'],
      sizeType: ['compressed'],
      success: (res) => {
        const tempFilePath = res.tempFiles[0].tempFilePath
        this.handlePhoto(tempFilePath)
      }
    })
  },

  // 处理拍照/选图结果 —— 上传图片到云存储并调用 OCR
  handlePhoto(filePath) {
    // 先显示图片和加载状态
    this.setData({
      ocrImagePath: filePath,
      inputMode: 'photo',
      isProcessing: true,
      ocrResult: ''
    })
    wx.showLoading({ title: '识别中...' })

    // 检查云开发是否可用
    if (!wx.cloud) {
      wx.hideLoading()
      this.setData({ isProcessing: false })
      wx.showToast({ title: '云开发未启用，请手动填写', icon: 'none' })
      return
    }

    // 上传图片到云存储
    const cloudPath = `ocr/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`
    wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success: (uploadRes) => {
        const fileID = uploadRes.fileID
        // 调用 OCR 云函数
        wx.cloud.callFunction({
          name: 'ocr',
          data: { fileID },
          success: (callRes) => {
            wx.hideLoading()
            const result = callRes.result
            if (result && result.success) {
              this.handleOCRResult(result.text)
            } else {
              this.setData({ isProcessing: false })
              wx.showToast({
                title: result.error || '识别失败',
                icon: 'none'
              })
            }
            // 清理云存储文件（可选，节省空间）
            wx.cloud.deleteFile({ fileList: [fileID] })
          },
          fail: (err) => {
            wx.hideLoading()
            this.setData({ isProcessing: false })
            console.error('调用云函数失败:', err)
            wx.showToast({ title: '识别失败，请手动填写', icon: 'none' })
          }
        })
      },
      fail: (err) => {
        wx.hideLoading()
        this.setData({ isProcessing: false })
        console.error('上传文件失败:', err)
        wx.showToast({ title: '上传失败，请手动填写', icon: 'none' })
      }
    })
  },

  // 关闭图片预览
  closePhoto() {
    this.setData({
      ocrImagePath: '',
      ocrResult: '',
      inputMode: 'manual'
    })
  },

  // 处理 OCR 识别结果，自动填充日期
  handleOCRResult(text) {
    this.setData({ ocrResult: text, isProcessing: false })

    const dateInfo = util.extractDateInfo(text)
    const updates = {}

    if (dateInfo.productionDate) {
      updates.productionDate = dateInfo.productionDate
    }
    if (dateInfo.expiryDate) {
      updates.expiryDate = dateInfo.expiryDate
    }
    if (dateInfo.shelfLife) {
      updates.shelfLife = String(dateInfo.shelfLife)
      if (updates.productionDate && !updates.expiryDate) {
        updates.expiryDate = util.calcExpiryFromShelfLife(updates.productionDate, dateInfo.shelfLife)
      }
    }

    if (Object.keys(updates).length > 0) {
      this.setData(updates)
      wx.showToast({ title: '识别成功', icon: 'success' })
    } else {
      wx.showToast({ title: '未识别到日期，请手动填写', icon: 'none' })
    }
  },

  // 手动编辑 OCR 识别文本
  onOCRTextInput(e) {
    const text = e.detail.value
    this.setData({ ocrResult: text })
  },

  // 重新识别
  retryOCR() {
    if (this.data.ocrResult) {
      this.handleOCRResult(this.data.ocrResult)
    }
  },

  // 提交
  async onSubmit() {
    const { name, productionDate, expiryDate, category, alertDays, categoryIndex } = this.data

    if (!name.trim()) {
      wx.showToast({ title: '请输入物品名称', icon: 'none' })
      return
    }

    if (!expiryDate) {
      wx.showToast({ title: '请选择到期日期', icon: 'none' })
      return
    }

    const item = {
      name: name.trim(),
      productionDate,
      expiryDate,
      category: this.data.categories[categoryIndex],
      alertDays,
      value: parseFloat(this.data.value) || 0
    }

    wx.showLoading({ title: '保存中...' })
    try {
      const saved = await app.addItem(item)
      // 记录追踪统计（不阻塞），维度随当前视角
      syncUtil.recordAdd(app.getViewGroupId(), saved.id)
      wx.hideLoading()
      wx.showToast({
        title: '添加成功',
        icon: 'success',
        duration: 1500,
        success: () => {
          setTimeout(() => wx.navigateBack(), 1500)
        }
      })
    } catch (err) {
      wx.hideLoading()
      console.error('添加失败:', err)
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    }
  },

  // 获取今天日期
  getToday() {
    return util.formatDate(new Date())
  }
})
