import logger from '../logger'
import * as FsGen from '../actions/fs-gen'
import * as Constants from '../constants/fs'
import * as ChatConstants from '../constants/chat2'
import * as Types from '../constants/types/fs'
import * as Container from '../util/container'
import * as RPCTypes from '../constants/types/rpc-gen'
import {produce, Draft} from 'immer'

const initialState: Types.State = {
  badge: RPCTypes.FilesTabBadge.none,
  destinationPicker: {
    destinationParentPath: [],
    source: {
      type: Types.DestinationPickerSource.None,
    },
  },
  downloads: {
    info: new Map(),
    regularDownloads: [],
    state: new Map(),
  },
  edits: new Map(),
  errors: new Map(),
  fileContext: new Map(),
  folderViewFilter: null,
  kbfsDaemonStatus: Constants.unknownKbfsDaemonStatus,
  lastPublicBannerClosedTlf: '',
  overallSyncStatus: Constants.emptyOverallSyncStatus,
  pathInfos: new Map(),
  pathItemActionMenu: Constants.emptyPathItemActionMenu,
  pathItems: new Map(),
  pathUserSettings: new Map(),
  sendAttachmentToChat: Constants.emptySendAttachmentToChat,
  settings: Constants.emptySettings,
  sfmi: {
    directMountDir: '',
    driverStatus: Constants.defaultDriverStatus,
    preferredMountDirs: [],
    showingBanner: false,
  },
  softErrors: {
    pathErrors: new Map(),
    tlfErrors: new Map(),
  },
  tlfUpdates: [],
  tlfs: {
    additionalTlfs: new Map(),
    loaded: false,
    private: new Map(),
    public: new Map(),
    team: new Map(),
  },
  uploads: {
    endEstimate: undefined,
    errors: new Map(),
    syncingPaths: new Set(),
    totalSyncingBytes: 0,
    writingToJournal: new Set(),
  },
}

export const _initialStateForTest = initialState

const updatePathItem = (
  oldPathItem: Types.PathItem,
  newPathItemFromAction: Types.PathItem
): Types.PathItem => {
  if (
    oldPathItem.type === Types.PathType.Folder &&
    newPathItemFromAction.type === Types.PathType.Folder &&
    oldPathItem.progress === Types.ProgressType.Loaded &&
    newPathItemFromAction.progress === Types.ProgressType.Pending
  ) {
    // The new one doesn't have children, but the old one has. We don't
    // want to override a loaded folder into pending. So first set the children
    // in new one using what we already have, see if they are equal.
    const newPathItemNoOverridingChildrenAndProgress = {
      ...newPathItemFromAction,
      children: oldPathItem.children,
      progress: Types.ProgressType.Loaded,
    }
    return newPathItemNoOverridingChildrenAndProgress
  }
  return newPathItemFromAction
}

const withFsErrorBar = (draftState: Draft<Types.State>, action: FsGen.FsErrorPayload) => {
  const fsError = action.payload.error
  if (
    draftState.kbfsDaemonStatus.onlineStatus === Types.KbfsDaemonOnlineStatus.Offline &&
    action.payload.expectedIfOffline
  ) {
    return
  }
  logger.error('error (fs)', fsError.erroredAction.type, fsError.errorMessage)
  // @ts-ignore TS is correct here. TODO fix we're passing buffers as strings
  draftState.errors = new Map([...draftState.errors, [Constants.makeUUID(), fsError]])
}

const updateExistingEdit = (
  draftState: Draft<Types.State>,
  editID: Types.EditID,
  change: (draftEdit: Draft<Types.Edit>) => void
) => {
  const existing = draftState.edits.get(editID)
  if (existing) {
    draftState.edits = new Map([...draftState.edits, [editID, produce(existing, change)]])
  }
}

const reduceFsError = (draftState: Draft<Types.State>, action: FsGen.FsErrorPayload) => {
  const fsError = action.payload.error
  const {erroredAction} = fsError
  switch (erroredAction.type) {
    case FsGen.commitEdit:
      withFsErrorBar(draftState, action)
      updateExistingEdit(
        draftState,
        erroredAction.payload.editID,
        draftEdit => (draftEdit.status = Types.EditStatusType.Failed)
      )
      return
    case FsGen.upload:
      // Don't show error bar in this case, as the uploading row already shows
      // a "retry" button.
      draftState.uploads.errors = new Map([
        ...draftState.uploads.errors,
        [
          Constants.getUploadedPath(erroredAction.payload.parentPath, erroredAction.payload.localPath),

          fsError,
        ],
      ])
      return
    case FsGen.saveMedia:
    case FsGen.shareNative:
    case FsGen.download:
    default:
      withFsErrorBar(draftState, action)
  }
}

export default Container.makeReducer<FsGen.Actions, Types.State>(initialState, {
  [FsGen.resetStore]: () => {
    return initialState
  },
  [FsGen.pathItemLoaded]: (draftState, action) => {
    const oldPathItem = Constants.getPathItem(draftState.pathItems, action.payload.path)
    draftState.pathItems.set(action.payload.path, updatePathItem(oldPathItem, action.payload.pathItem))
    draftState.softErrors.pathErrors.delete(action.payload.path)
    draftState.softErrors.tlfErrors.delete(action.payload.path)
  },
  [FsGen.folderListLoaded]: (draftState, action) => {
    action.payload.pathItems.forEach((pathItemFromAction, path) => {
      const oldPathItem = Constants.getPathItem(draftState.pathItems, path)
      const newPathItem = updatePathItem(oldPathItem, pathItemFromAction)
      oldPathItem.type === Types.PathType.Folder &&
        oldPathItem.children.forEach(
          name =>
            (newPathItem.type !== Types.PathType.Folder || !newPathItem.children.has(name)) &&
            draftState.pathItems.delete(Types.pathConcat(path, name))
        )
      draftState.pathItems.set(path, newPathItem)
    })
  },
  [FsGen.favoritesLoaded]: (draftState, action) => {
    draftState.tlfs.private = action.payload.private
    draftState.tlfs.public = action.payload.public
    draftState.tlfs.team = action.payload.team
    draftState.tlfs.loaded = true
  },
  [FsGen.loadedAdditionalTlf]: (draftState, action) => {
    draftState.tlfs.additionalTlfs.set(action.payload.tlfPath, action.payload.tlf)
  },
  [FsGen.setTlfsAsUnloaded]: draftState => {
    draftState.tlfs.loaded = false
  },
  [FsGen.setFolderViewFilter]: (draftState, action) => {
    draftState.folderViewFilter = action.payload.filter
  },
  [FsGen.tlfSyncConfigLoaded]: (draftState, action) => {
    const oldTlfList = draftState.tlfs[action.payload.tlfType]
    const oldTlfFromFavorites = oldTlfList.get(action.payload.tlfName) || Constants.unknownTlf
    if (oldTlfFromFavorites !== Constants.unknownTlf) {
      draftState.tlfs[action.payload.tlfType] = new Map([
        ...oldTlfList,
        [
          action.payload.tlfName,
          {
            ...oldTlfFromFavorites,
            syncConfig: action.payload.syncConfig,
          },
        ],
      ])
      return
    }

    const tlfPath = Types.pathConcat(
      Types.pathConcat(Constants.defaultPath, action.payload.tlfType),
      action.payload.tlfName
    )
    const oldTlfFromAdditional = draftState.tlfs.additionalTlfs.get(tlfPath) || Constants.unknownTlf
    if (oldTlfFromAdditional !== Constants.unknownTlf) {
      draftState.tlfs.additionalTlfs = new Map([
        ...draftState.tlfs.additionalTlfs,
        [
          tlfPath,
          {
            ...oldTlfFromAdditional,
            syncConfig: action.payload.syncConfig,
          },
        ],
      ])
      return
    }
  },
  [FsGen.sortSetting]: (draftState, action) => {
    const pathUserSetting =
      draftState.pathUserSettings.get(action.payload.path) || Constants.defaultPathUserSetting
    draftState.pathUserSettings.set(action.payload.path, {
      ...pathUserSetting,
      sort: action.payload.sortSetting,
    })
  },
  [FsGen.uploadStarted]: (draftState, action) => {
    draftState.uploads.writingToJournal = new Set([
      ...draftState.uploads.writingToJournal,
      action.payload.path,
    ])
  },
  [FsGen.uploadWritingSuccess]: (draftState, action) => {
    const {path} = action.payload
    if (draftState.uploads.errors.has(path)) {
      const errors = new Map(draftState.uploads.errors)
      errors.delete(path)
      draftState.uploads.errors = errors
    }
    if (draftState.uploads.writingToJournal.has(path)) {
      const writingToJournal = new Set(draftState.uploads.writingToJournal)
      writingToJournal.delete(path)
      draftState.uploads.writingToJournal = writingToJournal
    }
  },
  [FsGen.journalUpdate]: (draftState, action) => {
    const {syncingPaths, totalSyncingBytes, endEstimate} = action.payload
    draftState.uploads.syncingPaths = new Set(syncingPaths)
    draftState.uploads.totalSyncingBytes = totalSyncingBytes
    draftState.uploads.endEstimate = endEstimate || undefined
  },
  [FsGen.favoriteIgnore]: (draftState, action) => {
    const elems = Types.getPathElements(action.payload.path)
    const visibility = Types.getVisibilityFromElems(elems)
    if (!visibility) {
      return
    }
    draftState.tlfs[visibility] = new Map(draftState.tlfs[visibility])
    draftState.tlfs[visibility].set(elems[2], {
      ...(draftState.tlfs[visibility].get(elems[2]) || Constants.unknownTlf),
      isIgnored: true,
    })
  },
  [FsGen.favoriteIgnoreError]: (draftState, action) => {
    const elems = Types.getPathElements(action.payload.path)
    const visibility = Types.getVisibilityFromElems(elems)
    if (!visibility) {
      return
    }
    draftState.tlfs[visibility] = new Map(draftState.tlfs[visibility])
    draftState.tlfs[visibility].set(elems[2], {
      ...(draftState.tlfs[visibility].get(elems[2]) || Constants.unknownTlf),
      isIgnored: false,
    })
  },
  [FsGen.newFolderRow]: (draftState, action) => {
    const {parentPath} = action.payload
    const parentPathItem = Constants.getPathItem(draftState.pathItems, parentPath)
    if (parentPathItem.type !== Types.PathType.Folder) {
      console.warn(`bad parentPath: ${parentPathItem.type}`)
      return
    }

    const existingNewFolderNames = new Set([...draftState.edits].map(([_, {name}]) => name))

    let newFolderName = 'New Folder'
    for (
      let i = 2;
      parentPathItem.children.has(newFolderName) || existingNewFolderNames.has(newFolderName);
      ++i
    ) {
      newFolderName = `New Folder ${i}`
    }

    draftState.edits.set(Constants.makeEditID(), {
      ...Constants.emptyNewFolder,
      hint: newFolderName,
      name: newFolderName,
      parentPath,
    })
  },
  [FsGen.newFolderName]: (draftState, action) => {
    updateExistingEdit(draftState, action.payload.editID, draftEdit => {
      draftEdit.name = action.payload.name
    })
  },
  [FsGen.commitEdit]: (draftState, action) => {
    updateExistingEdit(draftState, action.payload.editID, draftEdit => {
      draftEdit.status = Types.EditStatusType.Saving
    })
  },
  [FsGen.editSuccess]: (draftState, action) => {
    if (draftState.edits.has(action.payload.editID)) {
      const edits = new Map(draftState.edits)
      edits.delete(action.payload.editID)
      draftState.edits = edits
    }
  },
  [FsGen.discardEdit]: (draftState, action) => {
    if (draftState.edits.has(action.payload.editID)) {
      const edits = new Map(draftState.edits)
      edits.delete(action.payload.editID)
      draftState.edits = edits
    }
  },
  [FsGen.fsError]: (draftState, action) => {
    reduceFsError(draftState, action)
  },
  [FsGen.userFileEditsLoaded]: (draftState, action) => {
    draftState.tlfUpdates = action.payload.tlfUpdates
  },
  [FsGen.dismissFsError]: (draftState, action) => {
    if (draftState.errors.has(action.payload.key)) {
      const errors = new Map(draftState.errors)
      errors.delete(action.payload.key)
      draftState.errors = errors
    }
  },
  [FsGen.showMoveOrCopy]: (draftState, action) => {
    draftState.destinationPicker.source =
      draftState.destinationPicker.source.type === Types.DestinationPickerSource.MoveOrCopy
        ? draftState.destinationPicker.source
        : ({
            path: Constants.defaultPath,
            type: Types.DestinationPickerSource.MoveOrCopy,
          } as const)

    draftState.destinationPicker.destinationParentPath = [action.payload.initialDestinationParentPath]
  },
  [FsGen.setMoveOrCopySource]: (draftState, action) => {
    draftState.destinationPicker.source = {
      path: action.payload.path,
      type: Types.DestinationPickerSource.MoveOrCopy,
    }
  },
  [FsGen.setDestinationPickerParentPath]: (draftState, action) => {
    if (draftState.destinationPicker.destinationParentPath[action.payload.index] !== action.payload.path) {
      draftState.destinationPicker.destinationParentPath[action.payload.index] = action.payload.path
    }
  },
  [FsGen.showIncomingShare]: (draftState, action) => {
    draftState.destinationPicker.source =
      draftState.destinationPicker.source.type === Types.DestinationPickerSource.IncomingShare
        ? draftState.destinationPicker.source
        : ({
            localPath: Types.stringToLocalPath(''),
            type: Types.DestinationPickerSource.IncomingShare,
          } as const)
    draftState.destinationPicker.destinationParentPath = [action.payload.initialDestinationParentPath]
  },
  [FsGen.setIncomingShareLocalPath]: (draftState, action) => {
    draftState.destinationPicker.source = {
      localPath: action.payload.localPath,
      type: Types.DestinationPickerSource.IncomingShare,
    } as const
  },
  [FsGen.initSendAttachmentToChat]: (draftState, action) => {
    draftState.sendAttachmentToChat = {
      ...Constants.emptySendAttachmentToChat,
      path: action.payload.path,
      state: Types.SendAttachmentToChatState.PendingSelectConversation,
      title: Types.getPathName(action.payload.path),
    }
  },
  [FsGen.setSendAttachmentToChatConvID]: (draftState, action) => {
    draftState.sendAttachmentToChat.convID = action.payload.convID
    draftState.sendAttachmentToChat.state = ChatConstants.isValidConversationIDKey(action.payload.convID)
      ? Types.SendAttachmentToChatState.ReadyToSend
      : Types.SendAttachmentToChatState.PendingSelectConversation
  },
  [FsGen.setSendAttachmentToChatFilter]: (draftState, action) => {
    draftState.sendAttachmentToChat.filter = action.payload.filter
  },
  [FsGen.setSendAttachmentToChatTitle]: (draftState, action) => {
    draftState.sendAttachmentToChat.title = action.payload.title
  },
  [FsGen.sentAttachmentToChat]: draftState => {
    draftState.sendAttachmentToChat.state = Types.SendAttachmentToChatState.Sent
  },
  [FsGen.setPathItemActionMenuView]: (draftState, action) => {
    draftState.pathItemActionMenu.previousView = draftState.pathItemActionMenu.view
    draftState.pathItemActionMenu.view = action.payload.view
  },
  [FsGen.setPathItemActionMenuDownload]: (draftState, action) => {
    draftState.pathItemActionMenu.downloadID = action.payload.downloadID
    draftState.pathItemActionMenu.downloadIntent = action.payload.intent
  },
  [FsGen.waitForKbfsDaemon]: draftState => {
    draftState.kbfsDaemonStatus.rpcStatus = Types.KbfsDaemonRpcStatus.Waiting
  },
  [FsGen.kbfsDaemonRpcStatusChanged]: (draftState, action) => {
    if (action.payload.rpcStatus !== Types.KbfsDaemonRpcStatus.Connected) {
      draftState.kbfsDaemonStatus.onlineStatus = Types.KbfsDaemonOnlineStatus.Offline
    }
    draftState.kbfsDaemonStatus.rpcStatus = action.payload.rpcStatus
  },
  [FsGen.kbfsDaemonOnlineStatusChanged]: (draftState, action) => {
    draftState.kbfsDaemonStatus.onlineStatus = action.payload.online
      ? Types.KbfsDaemonOnlineStatus.Online
      : Types.KbfsDaemonOnlineStatus.Offline
  },
  [FsGen.overallSyncStatusChanged]: (draftState, action) => {
    draftState.overallSyncStatus.syncingFoldersProgress = action.payload.progress
    draftState.overallSyncStatus.diskSpaceStatus = action.payload.diskSpaceStatus
  },
  [FsGen.showHideDiskSpaceBanner]: (draftState, action) => {
    draftState.overallSyncStatus.showingBanner = action.payload.show
  },
  [FsGen.setDriverStatus]: (draftState, action) => {
    draftState.sfmi.driverStatus = action.payload.driverStatus
  },
  [FsGen.showSystemFileManagerIntegrationBanner]: draftState => {
    draftState.sfmi.showingBanner = true
  },
  [FsGen.hideSystemFileManagerIntegrationBanner]: draftState => {
    draftState.sfmi.showingBanner = false
  },
  [FsGen.driverEnable]: draftState => {
    if (draftState.sfmi.driverStatus.type === Types.DriverStatusType.Disabled) {
      draftState.sfmi.driverStatus.isEnabling = true
    }
  },
  [FsGen.driverKextPermissionError]: draftState => {
    if (draftState.sfmi.driverStatus.type === Types.DriverStatusType.Disabled) {
      draftState.sfmi.driverStatus.kextPermissionError = true
      draftState.sfmi.driverStatus.isEnabling = false
    }
  },
  [FsGen.driverDisabling]: draftState => {
    if (draftState.sfmi.driverStatus.type === Types.DriverStatusType.Enabled) {
      draftState.sfmi.driverStatus.isDisabling = true
    }
  },
  [FsGen.setDirectMountDir]: (draftState, action) => {
    draftState.sfmi.directMountDir = action.payload.directMountDir
  },
  [FsGen.setPreferredMountDirs]: (draftState, action) => {
    draftState.sfmi.preferredMountDirs = action.payload.preferredMountDirs
  },
  [FsGen.setPathSoftError]: (draftState, action) => {
    if (action.payload.softError) {
      draftState.softErrors.pathErrors.set(action.payload.path, action.payload.softError)
    } else {
      draftState.softErrors.pathErrors.delete(action.payload.path)
    }
  },
  [FsGen.setTlfSoftError]: (draftState, action) => {
    if (action.payload.softError) {
      draftState.softErrors.tlfErrors.set(action.payload.path, action.payload.softError)
    } else {
      draftState.softErrors.tlfErrors.delete(action.payload.path)
    }
  },
  [FsGen.setLastPublicBannerClosedTlf]: (draftState, action) => {
    draftState.lastPublicBannerClosedTlf = action.payload.tlf
  },
  [FsGen.settingsLoaded]: (draftState, action) => {
    if (action.payload.settings) {
      draftState.settings = action.payload.settings
    } else {
      draftState.settings.isLoading = false
    }
  },
  [FsGen.loadSettings]: draftState => {
    draftState.settings.isLoading = true
  },
  [FsGen.loadedPathInfo]: (draftState, action) => {
    draftState.pathInfos = draftState.pathInfos.set(action.payload.path, action.payload.pathInfo)
  },
  [FsGen.loadedDownloadStatus]: (draftState, action) => {
    draftState.downloads.regularDownloads = action.payload.regularDownloads
    draftState.downloads.state = action.payload.state

    const toDelete = [...draftState.downloads.info.keys()].filter(
      downloadID => !action.payload.state.has(downloadID)
    )
    if (toDelete.length) {
      const info = new Map(draftState.downloads.info)
      toDelete.forEach(downloadID => info.delete(downloadID))
      draftState.downloads.info = info
    }
  },
  [FsGen.loadedDownloadInfo]: (draftState, action) => {
    draftState.downloads.info.set(action.payload.downloadID, action.payload.info)
  },
  [FsGen.loadedFileContext]: (draftState, action) => {
    draftState.fileContext.set(action.payload.path, action.payload.fileContext)
  },
  [FsGen.loadedFilesTabBadge]: (draftState, action) => {
    draftState.badge = action.payload.badge
  },
})
