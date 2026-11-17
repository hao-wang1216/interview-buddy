[Setup]
AppId={{6EEAD957-1C1D-4AFD-9E1E-6431CD087947}
AppName=面试搭子
AppPublisher=Interview Buddy
AppVersion={#AppVersion}
VersionInfoVersion={#AppVersion}
VersionInfoDescription=面试搭子 Windows 安装程序
DefaultDirName={localappdata}\Programs\InterviewBuddy
DefaultGroupName=面试搭子
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
SetupIconFile={#PayloadRoot}\assets\interview-buddy.ico
UninstallDisplayIcon={app}\assets\interview-buddy.ico
OutputDir={#InstallerOutput}
OutputBaseFilename=InterviewBuddy-{#AppVersion}-Windows-x64-Setup
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "chinese"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"

[Files]
Source: "{#PayloadRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\面试搭子"; Filename: "{app}\InterviewBuddy.exe"; WorkingDir: "{app}"; IconFilename: "{app}\assets\interview-buddy.ico"
Name: "{userdesktop}\面试搭子"; Filename: "{app}\InterviewBuddy.exe"; WorkingDir: "{app}"; IconFilename: "{app}\assets\interview-buddy.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\InterviewBuddy.exe"; WorkingDir: "{app}"; Description: "打开面试搭子"; Flags: nowait postinstall skipifsilent
