import * as vscode from 'vscode';
import * as Constants from '../common/constants';
import { execPath } from 'process';
import { MagitRepository } from '../models/magitRepository';
import { gitRun, LogLevel } from '../utils/gitRawRunner';
import { MenuUtil, MenuState } from '../menu/menu';
import MagitUtils from '../utils/magitUtils';
import * as Diffing from './diffingCommands';
import { Section } from '../views/general/sectionHeader';
import * as path from 'path';
import FilePathUtils from '../utils/filePathUtils';
import * as fs from 'fs';
import ViewUtils from '../utils/viewUtils';
import GitTextUtils from '../utils/gitTextUtils';
import { magitConfig, views } from '../extension';
import MagitStatusView from '../views/magitStatusView';

const commitMenu = {
  title: 'Committing',
  commands: [
    { label: 'c', description: 'Commit', action: commit },
    { label: 'a', description: 'Amend', action: (menuState: MenuState) => ammendCommit(menuState, ['--amend']) },
    { label: 'e', description: 'Extend', action: (menuState: MenuState) => ammendCommit(menuState, ['--amend', '--no-edit']) },
    { label: 'w', description: 'Reword', action: (menuState: MenuState) => rewordCommit(menuState, ['--amend', '--only']) },
    { label: 'f', description: 'Fixup', action: (menuState: MenuState) => fixup(menuState) },
    { label: 'F', description: 'Instant Fixup', action: (menuState: MenuState) => instantFixup(menuState) },
  ]
};

export async function magitCommit(repository: MagitRepository) {

  const switches = [
    { key: '-a', name: '--all', description: 'Stage all modified and deleted files' },
    { key: '-e', name: '--allow-empty', description: 'Allow empty commit' },
    { key: '-s', name: '--signoff', description: 'Add Signed-off-by line' },
    { key: '-n', name: '--no-verify', description: 'Disable hooks' },
    { key: '-S', name: '--gpg-sign', description: 'GPG-sign commit' },
  ];

  return MenuUtil.showMenu(commitMenu, { repository, switches });
}

export async function commit({ repository, switches }: MenuState, commitArgs: string[] = []) {

  let stageAllSwitch = switches?.find(({ key }) => key === '-a');

  if (repository.indexChanges.length === 0 && !stageAllSwitch?.activated && stageAllSwitch) {
    if (await MagitUtils.confirmAction('Nothing staged. Stage and commit all unstaged changes?')) {
      stageAllSwitch.activated = true;
    }
  }

  const args = ['commit', ...MenuUtil.switchesToArgs(switches), ...commitArgs];

  // Use fast editor for better performance (bypasses slow code --wait)
  return runCommitLikeCommand(repository, args, { showStagedChanges: !stageAllSwitch?.activated, useFastEditor: true });
}

export async function ammendCommit({ repository, switches }: MenuState, commitArgs: string[] = []) {
  const args = ['commit', ...MenuUtil.switchesToArgs(switches), ...commitArgs];
  // Use fast editor for better performance (bypasses slow code --wait)
  // Don't show staged changes for amend - user is typically just editing the message
  return runCommitLikeCommand(repository, args, { showStagedChanges: false, useFastEditor: true });
}

export async function rewordCommit({ repository, switches }: MenuState, commitArgs: string[] = []) {
  const args = ['commit', ...MenuUtil.switchesToArgs(switches), ...commitArgs];
  // Use fast editor for better performance (bypasses slow code --wait)
  return runCommitLikeCommand(repository, args, { showStagedChanges: false, useFastEditor: true });
}

async function fixup({ repository, switches }: MenuState) {
  const sha = await MagitUtils.chooseCommit(repository, 'Fixup commit');

  if (sha) {
    const args = ['commit', ...MenuUtil.switchesToArgs(switches), '--fixup', sha];

    return await gitRun(repository.gitRepository, args);
  } else {
    throw new Error('No commit chosen to fixup');
  }
}

async function instantFixup({ repository, switches = [] }: MenuState) {
  const sha = await MagitUtils.chooseCommit(repository, 'Instantly Fixup commit');

  if (sha) {
    let shortHash = GitTextUtils.shortHash(sha);

    await gitRun(repository.gitRepository, ['commit', '--no-gpg-sign', '--no-edit', ...MenuUtil.switchesToArgs(switches), `--fixup=${shortHash}`, '--']);

    const args = ['rebase', '-i', '--autosquash', '--autostash', shortHash + '~'];

    return await gitRun(repository.gitRepository, args, { env: { 'GIT_SEQUENCE_EDITOR': 'true' } });
  } else {
    throw new Error('No commit chosen to fixup');
  }
}

interface CommitEditorOptions {
  updatePostCommitTask?: boolean;
  showStagedChanges?: boolean;
  editor?: string;
  propagateErrors?: boolean;
  /** Use fast direct editor instead of spawning code --wait */
  useFastEditor?: boolean;
}

let codePath: string = findCodePath();

export function setCodePath(path?: string) {
  if (path && path !== '') {
    codePath = path;
  } else {
    codePath = findCodePath();
  }
}

/**
 * Fast commit editor that opens COMMIT_EDITMSG directly in VS Code
 * without spawning an external `code --wait` process.
 * This is significantly faster (saves ~500ms-1s per commit).
 */
async function runCommitWithFastEditor(
  repository: MagitRepository,
  args: string[],
  { showStagedChanges, propagateErrors }: CommitEditorOptions = {}
): Promise<void> {
  const gitRepo = repository.gitRepository;

  // Get the git directory path correctly (handles submodules, worktrees, etc.)
  let gitDir: string;
  try {
    const gitDirResult = await gitRun(gitRepo, ['rev-parse', '--git-dir'], {}, LogLevel.None, false);
    gitDir = gitDirResult.stdout.trim();
    // If relative path, make it absolute
    if (!path.isAbsolute(gitDir)) {
      gitDir = path.join(gitRepo.rootUri.fsPath, gitDir);
    }
  } catch {
    // Fallback to default
    gitDir = path.join(gitRepo.rootUri.fsPath, '.git');
  }
  const commitMsgPath = path.join(gitDir, 'COMMIT_EDITMSG');

  // Check if --no-edit is specified (e.g., Extend operation)
  // In this case, just run the command directly without opening an editor
  if (args.includes('--no-edit')) {
    const result = await gitRun(gitRepo, args);
    vscode.window.setStatusBarMessage(
      `Git finished: ${result.stdout.replace(Constants.LineSplitterRegex, ' ')}`,
      Constants.StatusMessageDisplayTimeout
    );
    return;
  }

  let stagedEditorTask: Thenable<vscode.TextEditor> | undefined;
  let instructionStatus: vscode.Disposable | undefined;
  let closeListener: vscode.Disposable | undefined;

  // Determine the view columns before opening anything
  // The diff view should go where the magit status is, commit editor in the other column
  const statusUri = MagitStatusView.encodeLocation(repository);
  const statusView = views.get(statusUri.toString());
  let statusViewColumn = vscode.ViewColumn.One;
  if (statusView) {
    // Find which column the status view is in
    for (const tabGroup of vscode.window.tabGroups.all) {
      for (const tab of tabGroup.tabs) {
        const tabInput = tab.input;
        if (tabInput && typeof tabInput === 'object' && 'uri' in tabInput) {
          const tabUri = (tabInput as { uri: vscode.Uri }).uri;
          if (tabUri.toString() === statusView.uri.toString()) {
            statusViewColumn = tabGroup.viewColumn;
            break;
          }
        }
      }
    }
  }
  // Commit editor goes in the opposite column from the status view
  const commitEditorColumn = statusViewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;

  try {
    instructionStatus = vscode.window.setStatusBarMessage(`Type C-c C-c to finish, or C-c C-k to cancel`);

    if (showStagedChanges) {
      // Open the diff view in the same column as the magit status
      stagedEditorTask = Diffing.showDiffSection(repository, Section.Staged, true, statusViewColumn);
    }

    // Determine if this is an amend operation
    const isAmend = args.includes('--amend');
    const isReword = args.includes('--only');

    // Start fetching initial message and status in parallel for speed
    const initialMessageTask = isAmend
      ? gitRun(gitRepo, ['log', '-1', '--format=%B'], {}, LogLevel.None, false)
          .then(r => r.stdout)
          .catch(() => '')
      : Promise.resolve('');

    const statusTask = gitRun(gitRepo, ['status', '--porcelain=v1'], {}, LogLevel.None, false);
    const branchTask = gitRun(gitRepo, ['rev-parse', '--abbrev-ref', 'HEAD'], {}, LogLevel.None, false);

    // Wait for all info in parallel
    const [initialMessage, statusResult, branchResult] = await Promise.all([
      initialMessageTask,
      statusTask,
      branchTask
    ]);

    // Build the commit message template (similar to what git would create)
    let messageTemplate = initialMessage.trimEnd() + '\n';
    messageTemplate += '\n# Please enter the commit message for your changes. Lines starting\n';
    messageTemplate += "# with '#' will be ignored, and an empty message aborts the commit.\n";
    messageTemplate += '#\n';
    messageTemplate += `# On branch ${branchResult.stdout.trim()}\n`;

    if (statusResult.stdout.trim()) {
      messageTemplate += '#\n# Changes to be committed:\n';
      for (const line of statusResult.stdout.split('\n').filter(l => l.trim())) {
        const status = line.substring(0, 2);
        const file = line.substring(3);
        if (status[0] !== ' ' && status[0] !== '?') {
          let action = 'modified';
          if (status[0] === 'A') {
            action = 'new file';
          } else if (status[0] === 'D') {
            action = 'deleted';
          } else if (status[0] === 'R') {
            action = 'renamed';
          }
          messageTemplate += `#\t${action}:   ${file}\n`;
        }
      }
    }

    // Write the template to COMMIT_EDITMSG
    await fs.promises.writeFile(commitMsgPath, messageTemplate, 'utf8');

    // Open the file directly in VS Code (FAST - no code --wait needed!)
    const commitMsgUri = vscode.Uri.file(commitMsgPath);
    const commitDoc = await vscode.workspace.openTextDocument(commitMsgUri);
    // Store the actual document URI for comparison (avoids path normalization issues)
    const docUriString = commitDoc.uri.toString();

    // Open commit editor in the opposite column from where the diff/status view is
    const openedEditor = await vscode.window.showTextDocument(commitDoc, {
      viewColumn: commitEditorColumn,
      preview: false
    });

    // Move cursor to the beginning and ensure it's visible
    // Use a small delay to override VS Code's cursor position restoration
    const setCursorToStart = () => {
      const startPosition = new vscode.Position(0, 0);
      openedEditor.selection = new vscode.Selection(startPosition, startPosition);
      openedEditor.revealRange(new vscode.Range(startPosition, startPosition), vscode.TextEditorRevealType.AtTop);
    };
    setCursorToStart();
    // Also set after a brief delay to override any async cursor restoration
    setTimeout(setCursorToStart, 50);

    // Keep track of the latest document content as user edits
    // This ensures we capture the content even if save event doesn't fire
    let latestContent = commitDoc.getText();
    let changeListener: vscode.Disposable | undefined;
    let saveListener: vscode.Disposable | undefined;
    let tabChangeListener: vscode.Disposable | undefined;

    // Helper to check if a tab with our file is still open
    const isTabStillOpen = (): boolean => {
      for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
          const tabInput = tab.input;
          if (tabInput && typeof tabInput === 'object' && 'uri' in tabInput) {
            const tabUri = (tabInput as { uri: vscode.Uri }).uri;
            if (tabUri.toString() === docUriString) {
              return true;
            }
          }
        }
      }
      return false;
    };

    const editorClosed = new Promise<string>((resolve) => {
      // Track changes to always have latest content
      changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
        // Compare using URI string to avoid path normalization issues
        if (event.document.uri.toString() === docUriString) {
          latestContent = event.document.getText();
        }
      });

      // Also capture on save
      saveListener = vscode.workspace.onDidSaveTextDocument((savedDoc) => {
        if (savedDoc.uri.toString() === docUriString) {
          latestContent = savedDoc.getText();
        }
      });

      // Listen for tab changes to detect when our tab is closed
      tabChangeListener = vscode.window.tabGroups.onDidChangeTabs((event) => {
        // Check if our tab was closed
        for (const closedTab of event.closed) {
          const tabInput = closedTab.input;
          if (tabInput && typeof tabInput === 'object' && 'uri' in tabInput) {
            const tabUri = (tabInput as { uri: vscode.Uri }).uri;
            if (tabUri.toString() === docUriString) {
              resolve(latestContent);
              return;
            }
          }
        }
      });

      // Also listen for document close as a backup
      closeListener = vscode.workspace.onDidCloseTextDocument((closedDoc) => {
        if (closedDoc.uri.toString() === docUriString) {
          resolve(latestContent);
        }
      });
    });

    const finalMessage = await editorClosed;

    // Clean up the tab change listener
    if (tabChangeListener) {
      tabChangeListener.dispose();
    }

    // Clean up listeners
    if (changeListener) {
      changeListener.dispose();
    }
    if (saveListener) {
      saveListener.dispose();
    }

    // Check if message is empty (only comments or whitespace)
    const cleanedMessage = finalMessage
      .split('\n')
      .filter(line => !line.startsWith('#'))
      .join('\n')
      .trim();

    if (!cleanedMessage) {
      vscode.window.setStatusBarMessage(`Commit canceled.`, Constants.StatusMessageDisplayTimeout);
      if (propagateErrors) {
        throw new Error('Aborting commit due to empty commit message.');
      }
      return;
    }

    // Write the final message to disk (in case user closed without saving)
    // This ensures git reads the correct content
    await fs.promises.writeFile(commitMsgPath, finalMessage, 'utf8');

    // Build the final commit args (replace editor-requiring args with -F)
    const commitArgs = args.filter(arg => arg !== '--amend' && arg !== '--only');
    if (isAmend) {
      commitArgs.push('--amend');
    }
    if (isReword) {
      commitArgs.push('--only');
    }
    commitArgs.push('-F', commitMsgPath);
    commitArgs.push('--cleanup=strip');

    // Run the actual commit
    const result = await gitRun(gitRepo, commitArgs);
    vscode.window.setStatusBarMessage(
      `Git finished: ${result.stdout.replace(Constants.LineSplitterRegex, ' ')}`,
      Constants.StatusMessageDisplayTimeout
    );

  } catch (e: any) {
    const errorMsg = GitTextUtils.formatError(e);
    if (errorMsg.includes('Aborting commit due to empty commit message.')) {
      vscode.window.setStatusBarMessage(`Commit canceled.`, Constants.StatusMessageDisplayTimeout);
    } else {
      // Show the actual error so user knows what went wrong
      const fullError = e?.stderr || e?.stdout || e?.message || errorMsg;
      vscode.window.setStatusBarMessage(`Commit failed: ${fullError.substring(0, 200)}`, Constants.StatusMessageDisplayTimeout);
      console.error('Commit failed:', e);
      if (propagateErrors) {
        throw e;
      }
    }
  } finally {
    if (closeListener) {
      closeListener.dispose();
    }
    if (instructionStatus) {
      instructionStatus.dispose();
    }

    // Only try to close staged editor if it was created
    if (stagedEditorTask) {
      let stagedEditor: vscode.TextEditor | undefined;
      try {
        stagedEditor = await stagedEditorTask;
      } catch {
        // Staged editor might have been closed already
        stagedEditor = undefined;
      }
      if (stagedEditor) {
        for (const visibleEditor of vscode.window.visibleTextEditors) {
          if (visibleEditor.document.uri === stagedEditor.document.uri) {
            const stagedEditorViewColumn = ViewUtils.showDocumentColumn();
            await vscode.window.showTextDocument(stagedEditor.document, { viewColumn: stagedEditorViewColumn, preview: false });
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            if (!magitConfig.displayBufferSameColumn) {
              vscode.commands.executeCommand(`workbench.action.navigate${stagedEditorViewColumn === vscode.ViewColumn.One ? 'Right' : 'Left'}`);
            }
          }
        }
      }
    }

    // Refocus the magit status window after commit completes
    const statusUri = MagitStatusView.encodeLocation(repository);
    const statusView = views.get(statusUri.toString());
    if (statusView) {
      const doc = await vscode.workspace.openTextDocument(statusView.uri);
      await vscode.window.showTextDocument(doc, { viewColumn: ViewUtils.showDocumentColumn(doc), preview: false });
    }
  }
}

export async function runCommitLikeCommand(repository: MagitRepository, args: string[], { showStagedChanges, updatePostCommitTask, editor, propagateErrors, useFastEditor }: CommitEditorOptions = { showStagedChanges: true }) {

  // Use fast editor for simple commit/amend operations (no custom editor env var needed)
  // This bypasses the slow `code --wait` process
  if (useFastEditor && !editor) {
    return runCommitWithFastEditor(repository, args, { showStagedChanges, propagateErrors });
  }

  let stagedEditorTask: Thenable<vscode.TextEditor> | undefined;
  let instructionStatus;
  let editorListener;
  try {

    instructionStatus = vscode.window.setStatusBarMessage(`Type C-c C-c to finish, or C-c C-k to cancel`);

    if (showStagedChanges) {
      stagedEditorTask = Diffing.showDiffSection(repository, Section.Staged, true);
    }

    // This passes the path to (the first) open workspace as the first command
    // to the `code` command when invoked as `GIT_EDITOR`. This together with
    // `--reuse-window` forces VSCode to open COMMIT_EDITMSG in the current
    // workspace even if the file is more closely related to a different
    // window/workspace.
    //
    // https://github.com/kahole/edamagit/issues/301
    //
    // It's important that the workspace file is preferred over the folder
    // (given that it's in use) as the workspace will otherwise be closed
    // and reopened.
    //
    // https://github.com/kahole/edamagit/issues/316
    const currentInstancePath =
      vscode.workspace.workspaceFile?.fsPath ??
      vscode.workspace.workspaceFolders?.at(0)?.uri.fsPath ??
      '';

    const cmd = `"${codePath}" --wait --reuse-window ${currentInstancePath} `;

    const env: NodeJS.ProcessEnv = { 'GIT_EDITOR': cmd };

    if (editor) {
      env[editor] = cmd;
    }

    const commitSuccessMessageTask = gitRun(repository.gitRepository, args, { env });

    editorListener = vscode.window.onDidChangeActiveTextEditor(editor => {
      if (
        editor &&
        FilePathUtils.fileName(editor.document.uri) === 'COMMIT_EDITMSG' &&
        editor.document.getText(new vscode.Range(0, 0, 0, 1)) === ''
      ) {
        // Move the cursor to the beginning
        const position = editor.selection.active;
        const newPosition = position.with(0, 0);
        const newSelection = new vscode.Selection(newPosition, newPosition);
        editor.selection = newSelection;
      }
    });

    if (updatePostCommitTask) {
      await new Promise(r => setTimeout(r, 100));
      MagitUtils.magitStatusAndUpdate(repository);
    }

    const commitSuccessMessage = await commitSuccessMessageTask;

    vscode.window.setStatusBarMessage(`Git finished: ${commitSuccessMessage.stdout.replace(Constants.LineSplitterRegex, ' ')}`, Constants.StatusMessageDisplayTimeout);

  } catch (e) {
    vscode.window.setStatusBarMessage(`Commit canceled.`, Constants.StatusMessageDisplayTimeout);
    if (propagateErrors || !GitTextUtils.formatError(e).includes('Aborting commit due to empty commit message.')) {
      throw e;
    }
  } finally {
    if (editorListener) {
      editorListener.dispose();
    }
    if (instructionStatus) {
      instructionStatus.dispose();
    }

    const stagedEditor = await stagedEditorTask;
    if (stagedEditor) {
      for (const visibleEditor of vscode.window.visibleTextEditors) {
        if (visibleEditor.document.uri === stagedEditor.document.uri) {
          // This is a bit of a hack. Too bad about editor.hide() and editor.show() being deprecated.
          const stagedEditorViewColumn = ViewUtils.showDocumentColumn();
          await vscode.window.showTextDocument(stagedEditor.document, { viewColumn: stagedEditorViewColumn, preview: false });
          await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
          if (! magitConfig.displayBufferSameColumn) {
            vscode.commands.executeCommand(`workbench.action.navigate${stagedEditorViewColumn === vscode.ViewColumn.One ? 'Right' : 'Left'}`);
          }
        }
      }
    }
  }
}

function findCodePath(): string {
  // Check if we are currently running a Code Insiders or Codium build
  let isInsiders = vscode.env.appName.includes('Insider');
  let isCodium = vscode.env.appRoot.includes('codium');
  let isCursor = vscode.env.appName.includes('Cursor');
  let isWindsurf = vscode.env.appName.includes('Windsurf');
  let isDarwin = process.platform === 'darwin';
  let isWindows = process.platform === 'win32';
  let isLinux = process.platform === 'linux';
  let isRemote = !!vscode.env.remoteName;

  let codePath = 'code';
  if (isCodium && !isDarwin) {
    codePath = 'codium';
  }

  if (isInsiders && !isDarwin) {
    // On Mac the binary for the Insiders build is still called `code`
    codePath += '-insiders';
  }

  if (isCursor && isRemote) {
    // Cursor remote-server does not symlink to code but to cursor.
    codePath = 'cursor';
  }

  if (isWindows && isRemote) {
    // On window remote server, 'code' alias doesn't exist
    codePath += '.cmd';
  }
  if (isWindsurf &&  (isDarwin || isLinux)) {
    // Windsurf on Mac: is called 'windsurf'
    codePath = 'windsurf';
  }

  // Find the code binary on different platforms.
  if (isDarwin) {
    codePath = execPath.split(/(?<=\.app)/)[0] + '/Contents/Resources/app/bin/' + codePath;
  } else {
    codePath = path.join(path.dirname(execPath), 'bin', (isRemote ? 'remote-cli' : ''), codePath);
  }

  if (!fs.existsSync(codePath)) {
    return 'code';
  }

  return codePath;
}
