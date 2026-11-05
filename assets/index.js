/**
 * 界面层：一个 Vue 应用同时承载两个功能，用 utools.onPluginEnter 的 action.code 路由。
 *   code = '新建文件夹' → pack 模式（原 utools-file-to-folder 的主界面）
 *   code = '解散文件夹' → dissolve 模式（utools-extract-folder 的选项面板 + utools-file-to-folder 的一键解散）
 *
 * 文件操作全部通过 preload 暴露的 window.folderToolkit 完成，渲染进程不直接碰 fs。
 */

const MODE_PACK = 'pack';
const MODE_DISSOLVE = 'dissolve';

// 与 plugin.json 中 features[].code 保持一致
const FEATURE_DISSOLVE = '解散文件夹';

// 沿用 utools-extract-folder 的存储键，老用户已有的三项设置可以被直接读取
const OPTIONS_KEY = 'releaseFolderOptions';
// dbStorage 不适用于高频写入；这里做防抖 + 最小间隔双重保护，避免连续改动反复落盘
const SAVE_DEBOUNCE = 350;
// uTools 要求两次 db 写操作间隔 >= 300ms，退出路径同样不能豁免（否则主进程可能卡死）
const MIN_DB_WRITE_INTERVAL = 350;

function defaultOptions() {
  return {
    // 解散目标：空 = 各自上一级目录；相对名 = 上一级目录下的子目录；绝对路径 = 统一到这里
    targetDir: '',
    // recursive = 递归提取所有文件；keep = 子目录整体移出
    subFolder: 'recursive',
    // number = 自动编号；prefix = 文件夹__文件名；overwrite = 覆盖同名文件
    duplicate: 'number',
    renameAll: false,
    // 选中文件夹后直接解散，不再显示面板（原 utools-file-to-folder 的行为）
    autoRun: false
  };
}

/** 读取已保存的选项，兼容 utools-extract-folder 存下的三个布尔字段 */
function loadOptions() {
  const options = defaultOptions();
  let stored = null;
  try {
    stored = utools.dbStorage.getItem(OPTIONS_KEY);
  } catch (e) {
    stored = null;
  }
  // 旧版本可能把配置存成 JSON 字符串，这里一并兼容
  if (typeof stored === 'string') {
    try {
      stored = JSON.parse(stored);
    } catch (e) {
      return options;
    }
  }
  if (!stored || typeof stored !== 'object') {
    return options;
  }
  if (typeof stored.targetDir === 'string') {
    options.targetDir = stored.targetDir;
  }
  if (typeof stored.autoRun === 'boolean') {
    options.autoRun = stored.autoRun;
  }
  if (stored.subFolder === 'recursive' || stored.subFolder === 'keep') {
    options.subFolder = stored.subFolder;
  } else if (typeof stored.releaseSubFolders === 'boolean') {
    options.subFolder = stored.releaseSubFolders ? 'recursive' : 'keep';
  }
  if (stored.duplicate === 'number' || stored.duplicate === 'prefix' || stored.duplicate === 'overwrite') {
    options.duplicate = stored.duplicate;
  } else if (typeof stored.renameDuplicateFiles === 'boolean') {
    // 旧版 false 只表示「不重命名」，映射到 overwrite 会静默覆盖同名文件；落到安全的编号策略
    options.duplicate = stored.renameDuplicateFiles ? 'prefix' : 'number';
  }
  if (typeof stored.renameAll === 'boolean') {
    options.renameAll = stored.renameAll;
  } else if (typeof stored.renameAllFiles === 'boolean') {
    options.renameAll = stored.renameAllFiles;
  }
  return options;
}

/**
 * 读取文件管理器当前路径。
 * 官方 API readCurrentFolderPath() 是 Promise，且仅在活动系统窗口为文件管理器时有效；
 * 插件打开后活动窗口已是 uTools，通常取不到，此时界面退化为「只接受绝对路径」。
 */
async function readCurrentFolderPath() {
  try {
    if (typeof utools !== 'undefined' && typeof utools.readCurrentFolderPath === 'function') {
      const folderPath = await utools.readCurrentFolderPath();
      if (folderPath) {
        return folderPath;
      }
    }
  } catch (e) {
    // 非文件管理器窗口时可能失败，忽略
  }
  return '';
}

// index.html 的脚本在 </body> 前，DOM 已就绪：直接挂载并注册生命周期回调，
// 不等 window.onload，避免 uTools 先派发 onPluginEnter 时丢失首次进入的 payload。
Vue.createApp({
    data() {
      return {
        mode: MODE_PACK,
        filesData: [],
        folderName: '',
        currentFolderPath: '',
        options: loadOptions(),
        saveTimer: null,
        lastSaveAt: 0,
        needsSave: false,
        enterSeq: 0,
        resultMessage: ''
      };
    },
    computed: {
      isDissolve() {
        return this.mode === MODE_DISSOLVE;
      },
      canCreateFolder() {
        if (!this.folderName) {
          return false;
        }
        // 绝对路径不依赖「当前文件夹」，取不到当前路径时依然可用
        const toolkit = window.folderToolkit;
        return !!this.currentFolderPath || (!!toolkit && toolkit.isAbsolutePath(this.folderName));
      },
      canMoveOrCopy() {
        return !!this.filesData.length && !!this.folderName;
      }
    },
    watch: {
      options: {
        deep: true,
        handler() {
          this.scheduleSave();
        }
      }
    },
    methods: {
      /* ---------- 选项持久化 ---------- */
      scheduleSave(delay) {
        this.needsSave = true;
        if (this.saveTimer) {
          clearTimeout(this.saveTimer);
        }
        this.saveTimer = setTimeout(() => {
          this.saveTimer = null;
          this.persistOptions();
        }, typeof delay === 'number' ? delay : SAVE_DEBOUNCE);
      },
      /** 退出/隐藏前尝试落盘；间隔不足时 persistOptions 会自行延后，绝不 <300ms 连写 */
      flushOptions(isKill) {
        if (this.saveTimer) {
          clearTimeout(this.saveTimer);
          this.saveTimer = null;
        }
        // outCurrentPlugin 与 onPluginOut 可能接连触发，避免同一 key 高频双写
        if (!this.needsSave) {
          return;
        }
        // 进程即将结束时延后的定时器不会再执行；同步等到满足最小写间隔再落盘，
        // 既不违反 db 300ms 写间隔红线，也不会丢掉本次改动（最长 350ms）
        if (isKill && this.lastSaveAt && Date.now() - this.lastSaveAt < MIN_DB_WRITE_INTERVAL) {
          const deadline = Math.min(this.lastSaveAt + MIN_DB_WRITE_INTERVAL, Date.now() + MIN_DB_WRITE_INTERVAL);
          while (Date.now() < deadline) { /* 空转等待，期间不发起任何 db 写 */ }
        }
        this.persistOptions();
      },
      persistOptions() {
        const now = Date.now();
        const wait = MIN_DB_WRITE_INTERVAL - (now - this.lastSaveAt);
        if (wait > 0) {
          this.scheduleSave(wait);
          return;
        }
        // 记录「本次尝试」时间：写入失败也推进，避免失败后立刻重试形成 0ms 双写
        this.lastSaveAt = now;
        const { targetDir, subFolder, duplicate, renameAll, autoRun } = this.options;
        try {
          utools.dbStorage.setItem(OPTIONS_KEY, {
            targetDir,
            subFolder,
            duplicate,
            renameAll,
            autoRun,
            // 同步写回旧字段，降级回 utools-extract-folder 时仍能读到合理的设置
            releaseSubFolders: subFolder === 'recursive',
            renameDuplicateFiles: duplicate === 'prefix',
            renameAllFiles: duplicate === 'prefix' && renameAll
          });
          this.needsSave = false;
        } catch (e) {
          // 失败时保留 needsSave，后续改动或下次进入仍会补写
          if (typeof utools !== 'undefined' && typeof utools.showNotification === 'function') {
            utools.showNotification('设置保存失败：' + (e && e.message ? e.message : e));
          }
        }
      },

      /* ---------- 列表维护 ---------- */
      checkExistsFile(file) {
        const normalize = value => String(value || '').replace(/[\\/]+$/, '').toLowerCase();
        const target = normalize(file && file.path);
        return !!this.filesData.find(existsFile => normalize(existsFile.path) === target);
      },
      removeFileFromList(file) {
        const idx = this.filesData.indexOf(file);
        if (idx > -1) {
          this.filesData.splice(idx, 1);
        }
      },
      clearFileNames() {
        this.filesData = [];
        this.folderName = '';
        this.resultMessage = '';
      },
      /** 把 onPluginEnter 的 payload 统一成 { name, path, isDirectory, isFile }，剔除无法读取的项 */
      normalizeSelection(payload) {
        const files = Array.isArray(payload) ? payload.slice() : [];
        const valid = [];
        let skipped = 0;
        const toolkit = window.folderToolkit;
        files.forEach(file => {
          if (!file || typeof file.path !== 'string' || !file.path) {
            skipped++;
            return;
          }
          // 统一经 preload 补齐类型与链接标记，顺带把已不存在的路径剔除
          if (!toolkit || typeof toolkit.checkDragFile !== 'function') {
            skipped++;
            return;
          }
          // payload 缺 name 时用路径最后一段兜底，避免下游 path.join 收到 undefined
          if (typeof file.name !== 'string' || !file.name) {
            if (typeof toolkit.getBaseName !== 'function') {
              skipped++;
              return;
            }
            file.name = toolkit.getBaseName(file.path);
          }
          try {
            toolkit.checkDragFile(file);
            valid.push(file);
          } catch (e) {
            skipped++;
          }
        });
        if (skipped) {
          utools.showNotification(`已忽略 ${skipped} 项无法读取的内容`);
        }
        return valid;
      },
      dragFiles(e) {
        if (!e.dataTransfer || !e.dataTransfer.files) {
          return;
        }
        const toolkit = window.folderToolkit;
        if (!toolkit || typeof toolkit.checkDragFile !== 'function') {
          utools.showNotification('当前环境无法读取拖拽文件，请改用「选文件夹」');
          return;
        }
        let skipped = 0;
        for (const dragFile of e.dataTransfer.files) {
          // 新版 Electron 移除了 File.path，统一经 preload 取真实路径
          const filePath = typeof toolkit.getDragFilePath === 'function'
            ? toolkit.getDragFilePath(dragFile)
            : dragFile.path;
          if (!filePath) {
            skipped++;
            continue;
          }
          const name = (typeof dragFile.name === 'string' && dragFile.name)
            ? dragFile.name
            : (typeof toolkit.getBaseName === 'function' ? toolkit.getBaseName(filePath) : '');
          if (!name) {
            skipped++;
            continue;
          }
          const file = { name, path: filePath };
          try {
            toolkit.checkDragFile(file);
          } catch (err) {
            skipped++;
            continue;
          }
          if (this.isDissolve && !file.isDirectory) {
            skipped++;
            continue;
          }
          if (!this.checkExistsFile(file)) {
            this.filesData.push(file);
          }
        }
        if (skipped) {
          utools.showNotification(
            this.isDissolve
              ? '解散模式下只支持文件夹，已忽略 ' + skipped + ' 项'
              : '有 ' + skipped + ' 项无法读取真实路径（拖拽取路径不可用），已忽略；可改用「选文件夹」'
          );
        }
      },
      focusPrimaryInput() {
        this.$nextTick(() => {
          const input = this.isDissolve ? this.$refs.targetDirInput : this.$refs.folderNameInput;
          if (input) {
            input.focus();
          }
        });
      },

      /* ---------- 选择器 ---------- */
      selectFolderName() {
        const directoryNames = utools.showOpenDialog({ properties: ['openDirectory'] });
        if (directoryNames && directoryNames.length) {
          this.folderName = directoryNames[0];
        }
      },
      selectTargetDir() {
        const directoryNames = utools.showOpenDialog({ properties: ['openDirectory'] });
        if (directoryNames && directoryNames.length) {
          this.options.targetDir = directoryNames[0];
        }
      },
      selectFolders() {
        const directoryNames = utools.showOpenDialog({ properties: ['openDirectory', 'multiSelections'] });
        (directoryNames || []).forEach(dirPath => {
          const file = {
            name: window.folderToolkit.getBaseName(dirPath),
            path: dirPath,
            isDirectory: true,
            isFile: false
          };
          if (!this.checkExistsFile(file)) {
            this.filesData.push(file);
          }
        });
      },

      /* ---------- 执行 ---------- */
      /**
       * 表单回车。每个模式只有一个文本输入框，浏览器会触发隐式提交，
       * 不拦下来就会重新加载页面、丢掉已选列表，所以这里必须 prevent（见 index.html 的 @submit.prevent）。
       * 新建/移动是非破坏性的，回车直接执行最顺手；解散不可撤销，不绑定回车，必须点按钮确认。
       */
      onSubmit() {
        if (this.isDissolve) {
          return;
        }
        if (this.filesData.length) {
          if (this.canMoveOrCopy) {
            this.moveOrCopyFile(false);
          }
          return;
        }
        if (this.canCreateFolder) {
          this.createCurrentFolder();
        }
      },
      outCurrentPlugin() {
        this.flushOptions();
        utools.outPlugin();
        utools.hideMainWindow();
      },
      createCurrentFolder() {
        try {
          window.folderToolkit.createFolder(this.folderName, this.currentFolderPath);
        } catch (e) {
          utools.showNotification(e.message);
          return;
        }
        utools.showNotification('文件夹创建完成');
        this.clearFileNames();
        this.outCurrentPlugin();
      },
      moveOrCopyFile(copy) {
        try {
          window.folderToolkit.moveOrCopyFile(this.filesData, this.folderName, copy);
        } catch (e) {
          utools.showNotification(e.message);
          // 部分完成时已成功的项已从原位置消失：把它们移出列表，
          // 否则重试会被预检的「文件或文件夹不存在」整体拦下，永远无法收敛
          const toolkit = window.folderToolkit;
          if (toolkit && typeof toolkit.checkDragFile === 'function') {
            this.filesData = this.filesData.filter(file => {
              try {
                toolkit.checkDragFile(file);
                return true;
              } catch (err) {
                return false;
              }
            });
          }
          if (!this.filesData.length) {
            this.folderName = '';
            this.resultMessage = '';
          }
          return;
        }
        utools.showNotification(copy ? '文件或文件夹复制完成' : '文件或文件夹移动完成');
        this.clearFileNames();
        this.outCurrentPlugin();
      },
      dissolve() {
        if (!this.filesData.length) {
          utools.showNotification('请先添加要解散的文件夹');
          return;
        }
        const toolkit = window.folderToolkit;
        if (!toolkit || typeof toolkit.dissolveFolders !== 'function') {
          utools.showNotification('当前环境无法执行文件操作');
          return;
        }
        // 上一次部分成功后重试：过滤掉已经消失的文件夹，避免把它们报成「不存在」
        const existing = this.filesData.filter(file => {
          try {
            toolkit.checkDragFile(file);
            return !!file.isDirectory;
          } catch (e) {
            return false;
          }
        });
        if (!existing.length) {
          utools.showNotification('选中的文件夹都已不存在或不可解散，请重新添加');
          this.filesData = [];
          this.resultMessage = '';
          return;
        }
        let result;
        try {
          result = toolkit.dissolveFolders(existing, this.options);
        } catch (e) {
          utools.showNotification(e.message);
          return;
        }
        utools.showNotification(this.buildDissolveMessage(result));
        if (result.errors.length || result.skipped.length) {
          // 有失败/跳过时保留列表与面板，展示完整结果，便于查看与重试
          const lines = [];
          if (result.skipped.length) {
            lines.push('跳过：\n' + result.skipped.join('\n'));
          }
          if (result.errors.length) {
            lines.push('失败：\n' + result.errors.join('\n'));
          }
          this.resultMessage = lines.join('\n\n');
          return;
        }
        this.clearFileNames();
        this.outCurrentPlugin();
      },
      buildDissolveMessage(result) {
        let msg = `已解散 ${result.dissolved} 个文件夹，移出 ${result.moved} 项`;
        if (result.renamed) {
          msg += `，${result.renamed} 项重名已重命名`;
        }
        if (result.skipped.length) {
          msg += `，跳过 ${result.skipped.length} 项`;
        }
        if (result.errors.length) {
          msg += `，失败 ${result.errors.length} 项：${result.errors[0]}`;
        }
        return msg;
      },
      async refreshCurrentFolderPath() {
        const seq = ++this.enterSeq;
        const folderPath = await readCurrentFolderPath();
        // 快速连续进入时，丢弃过期的异步结果，避免旧路径覆盖新值
        if (seq !== this.enterSeq) {
          return;
        }
        this.currentFolderPath = folderPath;
      }
    },
    mounted() {
      if (typeof utools === 'undefined') {
        return;
      }
      const applyTheme = () => {
        if (typeof utools !== 'undefined' && typeof utools.isDarkColors === 'function') {
          document.documentElement.classList.toggle('dark', utools.isDarkColors());
        }
      };
      applyTheme();
      // 退出到后台时尝试落盘，避免防抖定时器未触发导致选项丢失
      if (typeof utools !== 'undefined' && typeof utools.onPluginOut === 'function') {
        utools.onPluginOut(isKill => this.flushOptions(isKill));
      }
      utools.onPluginEnter(({ code, payload }) => {
        applyTheme();
        // 常驻进程里定时器可能被清掉，进入时补写尚未落盘的选项
        if (this.needsSave) {
          this.persistOptions();
        }
        this.mode = code === FEATURE_DISSOLVE ? MODE_DISSOLVE : MODE_PACK;
        this.filesData = [];
        this.folderName = '';
        this.resultMessage = '';
        // 单例常驻时每次进入都重取，避免沿用上一次的过期路径
        this.currentFolderPath = '';
        this.refreshCurrentFolderPath();
        // 以 payload 形态判断，兼容不同版本 uTools 对 files 指令的 type 命名
        if (!Array.isArray(payload)) {
          this.focusPrimaryInput();
          return;
        }
        const files = this.normalizeSelection(payload);
        if (!this.isDissolve) {
          this.filesData = files;
          this.focusPrimaryInput();
          return;
        }
        const folders = files.filter(file => file.isDirectory);
        if (!folders.length) {
          utools.showNotification('选中的内容中没有文件夹，无法解散');
          this.outCurrentPlugin();
          return;
        }
        this.filesData = folders;
        // 原 utools-file-to-folder 的「选中即解散」：勾选后进入插件直接执行，不再显示面板
        if (this.options.autoRun) {
          this.dissolve();
          return;
        }
        this.focusPrimaryInput();
      });
    }
  }).mount('#app');
