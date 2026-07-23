// installer/src/App.cs — entry point, the borderless window shell (cosmic bg,
// glass rail, content viewport, bottom action bar), the 7 wizard pages, page
// transitions, and install/elevate/uninstall orchestration.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace EhSetup
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            Dpi.Aware();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // Diagnostics + graceful report: route any unhandled UI-thread exception
            // (paint/init) here instead of the raw .NET "unhandled exception" dialog.
            // The root cause of the original crash is fixed (G.Round with radius 0);
            // this only logs + shows a clean message so problems are diagnosable.
            try
            {
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            }
            catch { }
            Application.ThreadException += (s, e) => ReportCrash(e.Exception);
            AppDomain.CurrentDomain.UnhandledException += (s, e) => ReportCrash(e.ExceptionObject as Exception);

            bool uninstall = Array.IndexOf(args, "--uninstall") >= 0;
            bool elevated = Array.IndexOf(args, "--elevated") >= 0;
            int cfgi = Array.IndexOf(args, "--cfg");

            // Raise the system timer resolution to 1ms. WinForms.Timer is
            // otherwise coalesced to ~15.6ms, capping the render loop at ~60
            // FPS no matter how small its Interval. With 1ms resolution a
            // 2ms timer can actually fire fast enough for a ~400 FPS loop.
            WinMM.BeginPeriod(1);
            try
            {
                if (uninstall)
                {
                    Application.Run(new UninstallForm());
                    return 0;
                }
                if (elevated && cfgi >= 0 && File.Exists(args[cfgi + 1]))
                {
                    Application.Run(new SetupForm(Serialize.Read(args[cfgi + 1])));
                    return 0;
                }
                Application.Run(new SetupForm(null));
                return 0;
            }
            finally { WinMM.EndPeriod(1); }
        }

        // winmm: timeBeginPeriod / timeEndPeriod raise the global multimedia
        // timer resolution so the render loop's sub-16ms timer ticks for real.
        internal static class WinMM
        {
            [DllImport("winmm.dll")] private static extern int timeBeginPeriod(int p);
            [DllImport("winmm.dll")] private static extern int timeEndPeriod(int p);
            public static void BeginPeriod(int ms) { try { timeBeginPeriod(ms); } catch { } }
            public static void EndPeriod(int ms) { try { timeEndPeriod(ms); } catch { } }
        }

        private static void ReportCrash(Exception ex)
        {
            try
            {
                string log = Path.Combine(Path.GetTempPath(), "Editor-Helper-Setup-Error.log");
                File.AppendAllText(log, "[ " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " ]\n"
                    + (ex == null ? "(no exception object)" : ex.ToString()) + "\n\n");
            }
            catch { }
            try { MessageBox.Show("Не удалось запустить установщик Editor Helper.\n\n" + (ex == null ? "Неизвестная ошибка." : ex.Message),
                "Editor Helper — ошибка", MessageBoxButtons.OK, MessageBoxIcon.Error); } catch { }
            try { Application.Exit(); } catch { }
            Environment.Exit(1);
        }
    }

    // ── tiny binary cfg serializer (no BinaryFormatter) ─────────────────────────
    internal static class Serialize
    {
        public static void Write(string path, Cfg c)
        {
            using (StreamWriter w = new StreamWriter(path))
            {
                w.WriteLine(c.InstallPath);
                w.WriteLine(c.Desktop ? "1" : "0");
                w.WriteLine(c.StartMenu ? "1" : "0");
                w.WriteLine(c.Startup ? "1" : "0");
                w.WriteLine(c.LaunchOnFinish ? "1" : "0");
                w.WriteLine(c.AutoStart ? "1" : "0");
            }
        }
        public static Cfg Read(string path)
        {
            string[] l = File.ReadAllLines(path);
            return new Cfg
            {
                InstallPath = l[0],
                Desktop = l[1] == "1",
                StartMenu = l[2] == "1",
                Startup = l[3] == "1",
                LaunchOnFinish = l[4] == "1",
                AutoStart = l.Length > 5 && l[5] == "1",
            };
        }
    }

    // ── the main wizard window ─────────────────────────────────────────────────
    internal sealed class SetupForm : Form
    {
        private const int W = 940, H = 624;
        private const int RailW = 248;
        private const int TitleH = 40;
        private const int BarH = 68;

        private Titlebar title;
        private StepRail rail;
        private Panel content;
        private UiButton btnBack, btnNext;

        private Cfg cfg;
        private string welcomeVersion = "";
        private string[] steps = new string[] {
            "Приветствие", "Лицензия", "Путь установки",
            "Компоненты", "Готовность", "Установка", "Завершение"
        };
        private int page = 0;
        private bool installing;

        // page hosts
        private Panel[] pages = new Panel[7];
        // page-specific controls
        private ScrollTextView licenseBox; private UiCheck acceptCheck;
        private TextBox pathBox; private UiButton browseBtn; private Label pathFree, pathWarn;
        private UiCheck cDesktop, cStartMenu, cStartup, cLaunch;
        private UiProgress prog; private Label pctLabel, fileLabel, speedLabel, etaLabel, fileCountLabel, phaseLabel;
        private ScrollTextView logBox;
        private UiButton btnLaunch, btnOpenFolder, btnFinish;

        private Transition trans;
        private System.Windows.Forms.Timer anim;
        private DateTime last = DateTime.UtcNow;

        // Cached background (cosmic gradient + glows + the opaque card) rendered
        // once and blitted each paint — avoids recomputing the PathGradientBrushes
        // every time a transparent child invalidates and forces a parent repaint.
        // The starfield is NOT in here: the sidebar (StepRail) paints its own
        // twinkling stars each frame so the background animates without forcing
        // the content/pages to repaint (which is what made it lag before).
        private Bitmap bgBmp;
        // Brand avatar, pre-rendered as a 224px cover-fit square thumbnail at
        // load time (decoded from the embedded Assets.AvatarPng). Drawn clipped
        // to a rounded square on the welcome page and in the title-bar mark;
        // null → "EH"/"E" placeholder. Static so the title bar (a separate
        // control) can reach it without a back-reference.
        internal static Bitmap AvatarThumb;
        // Shared, deterministic starfield. Same positions for the static form bg
        // (title/bar/margins) and the animated sidebar, so the twinkling sidebar
        // stars are the same field as the rest — only the sidebar animates.
        private struct BgStar { public int X, Y, Sz, Base; public float Phase, Speed; }
        private static readonly BgStar[] stars = BuildStars();
        private float bgT;   // star twinkle time accumulator (advanced each frame)
        // Top-most fade cover for open/close transitions. Paints a translucent
        // bg-color overlay so the whole window can fade without touching
        // Form.Opacity (which would disable the DWM Mica backdrop).
        private DbPanel overlay;
        private float cover = 1F;     // 1 = fully covered (closed), 0 = revealed
        private bool shown, closing;
        private Action pendingClose;
        private long lastProgMs;      // throttle for install progress labels

        // Card fade mask over the content card. A page transition dissolves
        // THROUGH the card color (no text movement): fade the veil up over the
        // current page, swap the page, fade the veil down to reveal the new one.
        private DbPanel cardFade;
        private float fade;            // veil alpha 0..1 during a transition
        private int fadeToPage = -1;    // target page during fade-out (-1 = fading in)
        private bool fadeActive;

        // Cursor parallax: the sidebar's + title bar's starfields gently follow
        // the cursor (an offset from the window center, eased so it drifts).
        // The offset (StarOX/StarOY) is shared with those controls, which already
        // repaint every frame for their own animation — so the parallax adds no
        // extra invalidation at all. The form / content card / pages never
        // repaint on a cursor move; that's the cheap path, moving or at rest.
        private float parX, parY;
        private bool parValid, parMoving;
        // Throttle: the form bg + content pages only repaint while the cursor
        // parallax is moving the starfield behind the translucent card, and at
        // most ~60fps. Re-rendering the page text every frame at the full rate was
        // the lag; 60fps is smooth for a slow parallax drift.
        private DateTime lastFull;

        public SetupForm(Cfg preset)
        {
            cfg = preset ?? DefaultCfg();
            if (cfg.AutoStart) page = 5; // elevated relaunch: jump to installing

            FormBorderStyle = FormBorderStyle.None;
            StartPosition = preset == null ? FormStartPosition.CenterScreen : FormStartPosition.CenterScreen;
            Size = new Size(W, H);
            BackColor = C.Bg;
            DoubleBuffered = true;
            Font = F.Body;
            ShowInTaskbar = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);

            BuildChrome();
            BuildContent();
            BuildPages();
            BuildBottom();
            BuildOverlay();

            RenderBg();
            LoadAvatar();

            // High-FPS render loop: 2ms interval (with the 1ms timer resolution
            // raised in Program.Main) gives a ~500 FPS ceiling — comfortably
            // reaching 400 FPS. Animations are dt-based, so motion speed is
            // unchanged; only the frame rate rises. Real-world FPS is bounded
            // by paint cost + display refresh (typically 60-165 Hz), so this
            // mostly makes the animation smoother, not visibly "400".
            anim = new System.Windows.Forms.Timer { Interval = 2 };
            anim.Tick += AnimTick;
            anim.Start();

            Load += delegate { Chrome.Apply(Handle); };
            Shown += delegate
            {
                shown = true;
                if (cfg.AutoStart) { ShowPage(5); BeginInstall(); }
                else { ShowPage(0); ResolveVersionAsync(); }
            };
        }

        private static Cfg DefaultCfg()
        {
            return new Cfg
            {
                InstallPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Editor Helper"),
                Desktop = true, StartMenu = true, Startup = false, LaunchOnFinish = true, AutoStart = false,
            };
        }

        // ── chrome ──────────────────────────────────────────────────────────────
        private void BuildChrome()
        {
            title = new Titlebar();
            title.Dock = DockStyle.None;
            title.Bounds = new Rectangle(0, 0, W, TitleH);
            title.OnMinimize = () => WindowState = FormWindowState.Minimized;
            title.OnClose = () => FadeClose(() => { try { Application.Exit(); } catch { } });
            Controls.Add(title);

            rail = new StepRail();
            rail.Bounds = new Rectangle(0, TitleH, RailW, H - TitleH);
            rail.Steps = steps;
            rail.Current = 0;
            Controls.Add(rail);
        }

        // ── content viewport ────────────────────────────────────────────────────
        private void BuildContent()
        {
            content = new DbPanel();
            content.Bounds = new Rectangle(RailW, TitleH, W - RailW, H - TitleH - BarH);
            content.BackColor = Color.Transparent;
            // Clip content (and every page/child inside it) to the card's bounding
            // box so the sliding pages never paint past the card edges during a
            // page transition. A RECTANGULAR region (not a rounded path) keeps GDI
            // on its fast clip path and lets OptimizedDoubleBuffer stay effective —
            // a figure-shaped region forced the slow path and made slides janky.
            // Page text never reaches the rounded corners (34px padding vs 14px
            // radius), so a rect clip is visually identical but far cheaper.
            Rectangle card = new Rectangle(10, 10, content.Width - 20, content.Height - 20);
            content.Region = new Region(card);
            Controls.Add(content);
        }

        private void BuildBottom()
        {
            DbPanel bar = new DbPanel();
            bar.Bounds = new Rectangle(RailW, H - BarH, W - RailW, BarH);
            bar.BackColor = Color.Transparent;
            Controls.Add(bar);
            // Minimal lines: no hard top border on the action bar — the card's
            // soft shadow already separates content from the action area.

            btnBack = new UiButton { Kind = BtnKind.Ghost, Text = "Назад" };
            btnBack.Bounds = new Rectangle(bar.Width - 320, 16, 140, 42);
            btnBack.Click += (s, e) => Back();
            bar.Controls.Add(btnBack);

            btnNext = new UiButton { Kind = BtnKind.Primary, Text = "Продолжить" };
            btnNext.Bounds = new Rectangle(bar.Width - 164, 16, 148, 42);
            btnNext.Click += (s, e) => Next();
            bar.Controls.Add(btnNext);
        }

        // ── fade cover (open/close) ──────────────────────────────────────────────
        // A top-most transparent layer painted with a translucent bg-color.
        // Animating its alpha gives a window fade-in/fade-out WITHOUT using
        // Form.Opacity (which would flip the window to layered and permanently
        // drop the DWM Mica backdrop).
        private void BuildOverlay()
        {
            overlay = new DbPanel();
            overlay.Bounds = new Rectangle(0, 0, W, H);
            overlay.BackColor = Color.Transparent;
            overlay.Paint += (s, e) =>
            {
                if (cover > 0.01F)
                    using (SolidBrush b = new SolidBrush(Color.FromArgb((int)(cover * 255), C.Bg)))
                        e.Graphics.FillRectangle(b, overlay.ClientRectangle);
            };
            Controls.Add(overlay);
            overlay.BringToFront();
        }

        // ── background: rendered once into a bitmap, then blitted each paint ─────
        // The window is fixed-size (FormBorderStyle.None), so render once.
        // OnPaint becomes a single DrawImage instead of 3 PathGradientBrushes.
        private void RenderBg()
        {
            if (bgBmp != null) { try { bgBmp.Dispose(); } catch { } }
            bgBmp = new Bitmap(W, H, System.Drawing.Imaging.PixelFormat.Format32bppPArgb);
            using (Graphics g = Graphics.FromImage(bgBmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                Rectangle r = new Rectangle(0, 0, W, H);
                using (LinearGradientBrush lb = new LinearGradientBrush(r, Hex("#08080A"), Hex("#050506"), 90F))
                    g.FillRectangle(lb, r);
                // subtle white glow upper-right — strictly black/white, no tint
                Glow(g, r, 0.86F, 0.14F, 0.42F, Color.FromArgb(24, 130, 130, 130));
                // faint gray depth, lower-left
                Glow(g, r, 0.12F, 0.88F, 0.30F, Color.FromArgb(18, 70, 70, 70));
                // The starfield is NOT baked in here: it is drawn per-frame in
                // OnPaint so it can shift with the cursor parallax, and the card
                // is drawn there too so the moving stars show through the
                // translucent panel.
            }
        }
        // Deterministic starfield (fixed seed — no per-run randomness). Same
        // positions are used for the static form bg and the animated sidebar.
        private static BgStar[] BuildStars()
        {
            Random rnd = new Random(20260722);
            BgStar[] s = new BgStar[240];
            for (int i = 0; i < s.Length; i++)
            {
                s[i] = new BgStar
                {
                    X = rnd.Next(0, W),
                    Y = rnd.Next(0, H),
                    Base = rnd.Next(40, 170),
                    Sz = rnd.Next(0, 3),
                    // twinkle: each star has its own phase + speed so the field
                    // shimmers rather than pulsing in unison.
                    Phase = (float)(rnd.NextDouble() * Math.PI * 2.0),
                    Speed = 0.6F + (float)rnd.NextDouble() * 1.4F,
                };
            }
            return s;
        }
        // Draws the starfield. `t` is the twinkle time (0 for the static bg);
        // when `clip` is non-empty only stars inside it are drawn (sidebar pass).
        // Cursor parallax offset (shared with the title bar's stars so the
        // whole field drifts together).
        internal static float StarOX, StarOY;
        internal static void DrawStars(Graphics g, float t, Rectangle clip)
        {
            bool clipped = clip.Width > 0;
            int ox = (int)StarOX, oy = (int)StarOY;
            // One reused brush (color set per star) instead of allocating +
            // disposing a SolidBrush per star — this runs every frame, so it
            // matters at a high frame rate.
            using (SolidBrush br = new SolidBrush(Color.White))
            for (int i = 0; i < stars.Length; i++)
            {
                BgStar s = stars[i];
                int x = s.X + ox, y = s.Y + oy;
                if (x < 0) x += W; else if (x >= W) x -= W;   // wrap → seamless
                if (y < 0) y += H; else if (y >= H) y -= H;
                if (clipped && (x < clip.X || x > clip.Right || y < clip.Y || y > clip.Bottom)) continue;
                int b = s.Base + (int)(Math.Sin(s.Phase + t * s.Speed) * 45);
                if (b < 20) b = 20; else if (b > 235) b = 235;
                br.Color = Color.FromArgb(b, 240, 240, 240);  // pure white — black/white
                if (s.Sz <= 1) g.FillRectangle(br, x, y, 1, 1);
                else g.FillEllipse(br, x, y, s.Sz, s.Sz);
            }
        }
        // Eases the starfield offset toward a target derived from the cursor
        // (offset from the window center). Sets the shared StarOX/StarOY used by
        // DrawStars (form bg + title bar) and parMoving so AnimTick knows whether
        // to repaint the form this frame.
        private void UpdateParallax(float dt)
        {
            Point p;
            try { p = PointToClient(Cursor.Position); } catch { p = new Point(-1, -1); }
            bool inside = p.X >= 0 && p.Y >= 0 && p.X < W && p.Y < H;
            float tx = inside ? (p.X - W * 0.5F) * 0.045F : 0F;
            float ty = inside ? (p.Y - H * 0.5F) * 0.045F : 0F;
            float prevX = parX, prevY = parY;
            if (!parValid) { parX = tx; parY = ty; prevX = tx; prevY = ty; }
            parX += (tx - parX) * Math.Min(1F, 6F * dt);
            parY += (ty - parY) * Math.Min(1F, 6F * dt);
            parValid = true;
            StarOX = parX; StarOY = parY;
            float ddx = parX - prevX, ddy = parY - prevY;
            parMoving = (ddx * ddx + ddy * ddy) > 0.05F;
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            if (bgBmp == null) RenderBg();
            e.Graphics.DrawImage(bgBmp, 0, 0);
            // Starfield — drawn per-frame so it shifts with the cursor parallax
            // (StarOX/StarOY), behind the translucent card so the motion shows
            // through the panel (the right half moves with the cursor too, not
            // just the sidebar). This repaint is throttled to ~60fps in AnimTick
            // — re-rendering the page text every frame at the full rate was the lag.
            DrawStars(e.Graphics, 0F, default(Rectangle));
            Rectangle card = new Rectangle(RailW + 10, TitleH + 10, (W - RailW) - 20, (H - TitleH - BarH) - 20);
            G.Card(e.Graphics, card, 14);
        }
        private static void Glow(Graphics g, Rectangle area, float fx, float fy, float fr, Color col)
        {
            int cx = (int)(area.X + area.Width * fx);
            int cy = (int)(area.Y + area.Height * fy);
            int rad = (int)(Math.Max(area.Width, area.Height) * fr);
            if (rad <= 0) return;            // AddEllipse throws on a 0-size rect
            Rectangle e = new Rectangle(cx - rad, cy - rad, rad * 2, rad * 2);
            using (GraphicsPath p = new GraphicsPath())
            {
                p.AddEllipse(e);
                using (PathGradientBrush b = new PathGradientBrush(p))
                {
                    b.CenterColor = col;
                    b.SurroundColors = new Color[] { Color.FromArgb(0, col.R, col.G, col.B) };
                    g.FillPath(b, p);
                }
            }
        }
        private static Color Hex(string s) { return C.Hex(s); }

        // Decodes the embedded brand avatar (Assets.AvatarPng) once into a
        // 224px cover-fit square thumbnail, ready to blit clipped into the
        // welcome mark. Falls back to null (→ "EH" placeholder) on any error
        // or if no avatar was embedded.
        private void LoadAvatar()
        {
            try
            {
                if (Assets.AvatarPng == null || Assets.AvatarPng.Length == 0) return;
                using (MemoryStream ms = new MemoryStream(Assets.AvatarPng))
                using (Bitmap src = (Bitmap)Image.FromStream(ms))
                {
                    const int S = 224;
                    AvatarThumb = new Bitmap(S, S, System.Drawing.Imaging.PixelFormat.Format32bppPArgb);
                    using (Graphics g = Graphics.FromImage(AvatarThumb))
                    {
                        g.SmoothingMode = SmoothingMode.AntiAlias;
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        // cover-fit: fill the square, crop the overflow, center
                        float scale = Math.Max(S / (float)src.Width, S / (float)src.Height);
                        float dw = src.Width * scale, dh = src.Height * scale;
                        float dx = (S - dw) / 2F, dy = (S - dh) / 2F;
                        g.DrawImage(src, dx, dy, dw, dh);
                    }
                }
            }
            catch { AvatarThumb = null; }
        }
        // Draws the brand mark into the welcome hero area: the avatar clipped
        // to a rounded square with a soft glow + hairline frame, or the "EH"
        // gradient placeholder when no avatar is embedded.
        private void DrawHeroMark(Graphics g, Rectangle mark)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath pp = G.Round(mark, 30))
            {
                if (AvatarThumb != null)
                {
                    // soft outer halo so the avatar lifts off the card
                    G.GlowRound(g, mark, 30, Color.FromArgb(36, 255, 255, 255), 6);
                    Region old = g.Clip;
                    using (Region clip = new Region(pp))
                    {
                        g.Clip = clip;
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.DrawImage(AvatarThumb, mark.X, mark.Y, mark.Width, mark.Height);
                        g.InterpolationMode = InterpolationMode.Default;
                        g.Clip = old;
                    }
                    using (Pen pen = new Pen(C.BorderHi, 1.6F)) g.DrawPath(pen, pp);
                }
                else
                {
                    using (Brush b = G.AccentBrush(mark)) g.FillPath(b, pp);
                    using (SolidBrush b = new SolidBrush(C.OnAccent))
                    {
                        StringFormat sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
                        g.DrawString("EH", new Font("Segoe UI", 38F, FontStyle.Bold, GraphicsUnit.Pixel), b, mark, sf);
                    }
                }
            }
        }

        // ── pages ───────────────────────────────────────────────────────────────
        private void BuildPages()
        {
            for (int i = 0; i < 7; i++)
            {
                DbPanel p = new DbPanel();
                p.Bounds = new Rectangle(0, 0, content.Width, content.Height);
                p.BackColor = Color.Transparent;
                p.Visible = false;
                content.Controls.Add(p);
                pages[i] = p;
            }
            BuildWelcome();
            BuildLicense();
            BuildPath();
            BuildComponents();
            BuildReady();
            BuildInstalling();
            BuildFinish();
            BuildCardFade();
        }

        // Top-most (within content) translucent mask painted with the card
        // color. Animating its alpha gives Fade + Slide without compositing
        // transparent bitmaps (which GDI+ renders against an opaque parent).
        private void BuildCardFade()
        {
            cardFade = new DbPanel();
            cardFade.Bounds = new Rectangle(0, 0, content.Width, content.Height);
            cardFade.BackColor = Color.Transparent;
            cardFade.Visible = false;
            // smoothstep the veil alpha so the dissolve feels organic, not linear
            cardFade.Paint += (s, e) =>
            {
                float a = fade;
                if (a > 0.01F)
                {
                    a = a * a * (3F - 2F * a);
                    using (SolidBrush b = new SolidBrush(Color.FromArgb((int)(a * 255), C.CardFace)))
                        e.Graphics.FillRectangle(b, cardFade.ClientRectangle);
                }
            };
            content.Controls.Add(cardFade);
            cardFade.BringToFront();
        }

        private Rectangle ContentPad { get { return new Rectangle(34, 30, content.Width - 68, content.Height - 60); } }

        // Welcome
        private void BuildWelcome()
        {
            Panel p = pages[0];
            p.Paint += (s, e) =>
            {
                Graphics g = e.Graphics;
                Rectangle a = ContentPad;
                // hero mark — the brand avatar (or "EH" placeholder)
                Rectangle mark = new Rectangle(a.X + a.Width / 2 - 56, a.Y + 6, 112, 112);
                DrawHeroMark(g, mark);
                G.TextCenter(g, "Editor Helper", F.Title, C.Text, new Rectangle(a.X, mark.Bottom + 16, a.Width, 34));
                string ver = welcomeVersion;
                G.TextCenter(g, ver.Length > 0 ? "Версия " + ver : "Установщик", F.H2, C.TextMute, new Rectangle(a.X, mark.Bottom + 52, a.Width, 24));
                G.TextCenter(g, "Установка плагинов, скриптов и пресетов для Adobe After Effects.", F.Body, C.TextDim,
                    new Rectangle(a.X + 40, mark.Bottom + 92, a.Width - 80, 60));
            };
        }
        private string ResolveVersion()
        {
            try
            {
                string cb = DateTime.Now.Ticks.ToString();
                using (WebClient wc = new WebClient()) { wc.Headers.Add("User-Agent", "Editor-Helper-Setup"); return ParseVer(wc.DownloadString("https://raw.githubusercontent.com/dekixh/Editor-Helper-Lite/main/latest.txt").Trim()); }
            }
            catch { return ""; }
        }
        private void ResolveVersionAsync()
        {
            new Thread(new ThreadStart(() =>
            {
                string v = ResolveVersion();
                try { Invoke((Action)(() => { welcomeVersion = v; pages[0].Invalidate(); })); } catch { }
            })) { IsBackground = true }.Start();
        }
        private static string ParseVer(string url)
        {
            Match m = Regex.Match(url ?? "", "/download/(v?[^/]+)/", RegexOptions.IgnoreCase);
            return m.Success ? m.Groups[1].Value.TrimStart('v') : "";
        }

        // License
        private void BuildLicense()
        {
            Panel p = pages[1];
            acceptCheck = new UiCheck { Text = "Я принимаю условия лицензионного соглашения", Bounds = new Rectangle(34, content.Height - 76, 460, 28) };
            acceptCheck.CheckChanged += (s, e) => SyncNext();
            p.Controls.Add(acceptCheck);

            licenseBox = new ScrollTextView();
            licenseBox.Bounds = new Rectangle(34, 74, content.Width - 68, content.Height - 74 - 76);
            licenseBox.Font = F.Mono;
            licenseBox.SetText(LicenseText.Text);
            p.Controls.Add(licenseBox);
            p.Paint += (s, e) =>
            {
                G.TextLeft(e.Graphics, "Лицензионное соглашение", F.H1, C.Text, new Rectangle(34, 30, content.Width - 68, 30), false);
                G.TextLeft(e.Graphics, "Пожалуйста, ознакомьтесь с условиями перед установкой.", F.Body, C.TextMute, new Rectangle(34, 58, content.Width - 68, 20), false);
            };
        }

        // Path
        private void BuildPath()
        {
            Panel p = pages[2];
            pathBox = DarkBox();
            pathBox.Bounds = new Rectangle(34, 108, content.Width - 68 - 110, 42);
            pathBox.Text = cfg.InstallPath;
            pathBox.TextChanged += (s, e) => { cfg.InstallPath = pathBox.Text; UpdateFreeSpace(); SyncNext(); };
            p.Controls.Add(pathBox);

            browseBtn = new UiButton { Kind = BtnKind.Ghost, Text = "Обзор…", MinWidth = 100 };
            browseBtn.Bounds = new Rectangle(content.Width - 68 - 100 + 34, 108, 100, 42);
            browseBtn.Click += (s, e) =>
            {
                using (FolderBrowserDialog d = new FolderBrowserDialog { Description = "Выберите папку установки", SelectedPath = cfg.InstallPath })
                    if (d.ShowDialog(this) == DialogResult.OK) { pathBox.Text = d.SelectedPath; }
            };
            p.Controls.Add(browseBtn);

            pathFree = DimLabel(content.Width - 68, 18); pathFree.Location = new Point(34, 168); p.Controls.Add(pathFree);
            pathWarn = DimLabel(content.Width - 68, 18); pathWarn.Location = new Point(34, 190); pathWarn.ForeColor = C.Err; p.Controls.Add(pathWarn);

            p.Paint += (s, e) =>
            {
                G.TextLeft(e.Graphics, "Путь установки", F.H1, C.Text, new Rectangle(34, 30, content.Width - 68, 30), false);
                G.TextLeft(e.Graphics, "Куда установить Editor Helper. По умолчанию — папка пользователя.", F.Body, C.TextMute, new Rectangle(34, 56, content.Width - 68, 30), false);
            };
            p.VisibleChanged += (s, e) => { if (p.Visible) UpdateFreeSpace(); };
        }
        private TextBox DarkBox()
        {
            TextBox t = new TextBox();
            t.BorderStyle = BorderStyle.None;
            t.BackColor = Hex("#121214");
            t.ForeColor = C.Text;
            t.Font = F.Mono;
            t.Padding = new Padding(12, 11, 12, 11);
            return t;
        }
        private Label DimLabel(int w, int h) { Label l = new Label(); l.AutoSize = false; l.Size = new Size(w, h); l.Font = F.Small; l.ForeColor = C.TextMute; l.BackColor = Color.Transparent; return l; }
        private void UpdateFreeSpace()
        {
            long free = Installer.FreeBytes(cfg.InstallPath);
            pathFree.Text = "Свободно на диске: " + (free < 0 ? "—" : Installer.FmtBytes(free)) + "   ·   Требуется ~75 МБ";
            bool empty = cfg.InstallPath.Trim().Length == 0;
            pathWarn.Text = empty ? "Укажите папку установки." : "";
            if (page == 2) btnNext.Enabled = !empty;
        }

        // Components
        private void BuildComponents()
        {
            Panel p = pages[3];
            int y = 96;
            cDesktop = new UiCheck { Checked = cfg.Desktop, Text = "Ярлык на рабочем столе", Bounds = new Rectangle(34, y, 460, 30) }; y += 44;
            cStartMenu = new UiCheck { Checked = cfg.StartMenu, Text = "Ярлык в меню «Пуск»", Bounds = new Rectangle(34, y, 460, 30) }; y += 44;
            cStartup = new UiCheck { Checked = cfg.Startup, Text = "Запускать вместе с Windows", Bounds = new Rectangle(34, y, 460, 30) }; y += 44;
            cLaunch = new UiCheck { Checked = cfg.LaunchOnFinish, Text = "Запустить после установки", Bounds = new Rectangle(34, y, 460, 30) };
            cDesktop.CheckChanged += (s, e) => cfg.Desktop = cDesktop.Checked;
            cStartMenu.CheckChanged += (s, e) => cfg.StartMenu = cStartMenu.Checked;
            cStartup.CheckChanged += (s, e) => cfg.Startup = cStartup.Checked;
            cLaunch.CheckChanged += (s, e) => cfg.LaunchOnFinish = cLaunch.Checked;
            p.Controls.Add(cDesktop); p.Controls.Add(cStartMenu); p.Controls.Add(cStartup); p.Controls.Add(cLaunch);
            p.Paint += (s, e) =>
            {
                G.TextLeft(e.Graphics, "Компоненты", F.H1, C.Text, new Rectangle(34, 30, content.Width - 68, 30), false);
                G.TextLeft(e.Graphics, "Выберите, что создать при установке.", F.Body, C.TextMute, new Rectangle(34, 56, content.Width - 68, 30), false);
            };
        }

        // Ready
        private void BuildReady()
        {
            Panel p = pages[4];
            p.Paint += (s, e) =>
            {
                Graphics g = e.Graphics;
                G.TextLeft(g, "Всё готово к установке", F.H1, C.Text, new Rectangle(34, 30, content.Width - 68, 30), false);
                G.TextLeft(g, "Проверьте параметры и нажмите «Установить».", F.Body, C.TextMute, new Rectangle(34, 56, content.Width - 68, 24), false);
                Rectangle card = new Rectangle(34, 96, content.Width - 68, 210);
                G.Glass(g, card, S.RadiusSm);
                int y = card.Y + 22; int lx = card.X + 24; int vx = card.X + 230;
                Row(g, "Папка установки", cfg.InstallPath, lx, vx, ref y);
                Row(g, "Размер загрузки", "~75 МБ", lx, vx, ref y);
                Row(g, "Ярлык «Пуск»", cfg.StartMenu ? "да" : "нет", lx, vx, ref y);
                Row(g, "Ярлык на рабочем столе", cfg.Desktop ? "да" : "нет", lx, vx, ref y);
                Row(g, "Автозапуск с Windows", cfg.Startup ? "да" : "нет", lx, vx, ref y);
                Row(g, "Запустить после", cfg.LaunchOnFinish ? "да" : "нет", lx, vx, ref y);
            };
        }
        private static void Row(Graphics g, string k, string v, int lx, int vx, ref int y)
        {
            using (SolidBrush b = new SolidBrush(C.TextMute)) g.DrawString(k, F.Body, b, lx, y);
            using (SolidBrush b = new SolidBrush(C.Text)) g.DrawString(v, F.Body, b, vx, y);
            y += 30;
        }

        // Installing
        private void BuildInstalling()
        {
            Panel p = pages[5];
            phaseLabel = DimLabel(content.Width - 68, 26); phaseLabel.Location = new Point(34, 36); phaseLabel.Font = F.H1; phaseLabel.ForeColor = C.Text; p.Controls.Add(phaseLabel);
            pctLabel = DimLabel(120, 40); pctLabel.Location = new Point(34, 78); pctLabel.Font = new Font("Segoe UI", 30F, FontStyle.Bold, GraphicsUnit.Pixel); pctLabel.ForeColor = C.Text; p.Controls.Add(pctLabel);
            fileLabel = DimLabel(content.Width - 220, 20); fileLabel.Location = new Point(160, 96); fileLabel.ForeColor = C.TextDim; p.Controls.Add(fileLabel);
            prog = new UiProgress { Bounds = new Rectangle(34, 130, content.Width - 68, 14) };
            p.Controls.Add(prog);
            speedLabel = DimLabel(220, 20); speedLabel.Location = new Point(34, 158); speedLabel.ForeColor = C.TextMute; p.Controls.Add(speedLabel);
            etaLabel = DimLabel(220, 20); etaLabel.Location = new Point(260, 158); etaLabel.ForeColor = C.TextMute; p.Controls.Add(etaLabel);
            fileCountLabel = DimLabel(220, 20); fileCountLabel.Location = new Point(content.Width - 68 - 180 + 34, 158); fileCountLabel.ForeColor = C.TextMute; p.Controls.Add(fileCountLabel);

            logBox = new ScrollTextView();
            logBox.Bounds = new Rectangle(34, 196, content.Width - 68, content.Height - 196 - 18);
            logBox.Font = F.Mono;
            p.Controls.Add(logBox);
        }

        // Finish
        private void BuildFinish()
        {
            Panel p = pages[6];
            btnLaunch = new UiButton { Kind = BtnKind.Primary, Text = "Запустить" };
            btnOpenFolder = new UiButton { Kind = BtnKind.Ghost, Text = "Открыть папку" };
            btnFinish = new UiButton { Kind = BtnKind.Ghost, Text = "Готово" };
            btnLaunch.Bounds = new Rectangle(34, content.Height - 120, 170, 44);
            btnOpenFolder.Bounds = new Rectangle(214, content.Height - 120, 170, 44);
            btnFinish.Bounds = new Rectangle(394, content.Height - 120, 150, 44);
            btnLaunch.Click += (s, e) => LaunchApp();
            btnOpenFolder.Click += (s, e) => { try { Process.Start(cfg.InstallPath); } catch { } };
            btnFinish.Click += (s, e) => FadeClose(() => Close());
            p.Controls.Add(btnLaunch); p.Controls.Add(btnOpenFolder); p.Controls.Add(btnFinish);
            p.Paint += (s, e) =>
            {
                Graphics g = e.Graphics;
                Rectangle a = ContentPad;
                Rectangle circ = new Rectangle(a.X + a.Width / 2 - 40, a.Y + 10, 80, 80);
                using (GraphicsPath pp = G.Round(circ, 40)) using (Brush b = G.AccentBrush(circ)) { g.SmoothingMode = SmoothingMode.AntiAlias; g.FillPath(b, pp); }
                using (Pen pen = new Pen(C.OnAccent, 5F) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                    g.DrawLines(pen, new PointF[] { new PointF(circ.X + 22, circ.Y + 44), new PointF(circ.X + 35, circ.Y + 57), new PointF(circ.X + 60, circ.Y + 28) });
                G.TextCenter(g, "Установка завершена", F.Title, C.Text, new Rectangle(a.X, circ.Bottom + 18, a.Width, 34));
                G.TextCenter(g, "Editor Helper установлен и готов к работе.", F.Body, C.TextDim, new Rectangle(a.X + 40, circ.Bottom + 58, a.Width - 80, 30));
            };
        }

        private void LaunchApp()
        {
            try
            {
                string exe = Path.Combine(cfg.InstallPath, "Editor-Helper.exe");
                if (File.Exists(exe)) Process.Start(exe);
            }
            catch { }
            FadeClose(() => Close());
        }

        // ── window fade-out, then perform the real close action ──────────────────
        private void FadeClose(Action after)
        {
            if (closing) return;
            closing = true;
            pendingClose = after;
            if (!overlay.Visible) overlay.Visible = true;
        }
        private void DoPendingClose()
        {
            Action a = pendingClose;
            pendingClose = null;
            if (a == null) { try { Close(); } catch { } return; }
            try { a(); } catch { }
        }
        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            try { if (bgBmp != null) bgBmp.Dispose(); } catch { }
            try { if (AvatarThumb != null) AvatarThumb.Dispose(); } catch { }
            base.OnFormClosed(e);
        }

        // ── navigation ──────────────────────────────────────────────────────────
        // Swaps to page `i` instantly (visibility + rail + buttons). The veil is
        // already up when this is called, so the swap is hidden behind the card
        // color — the user only sees the dissolve, never the hard cut.
        private void SwitchPage(int i)
        {
            page = i;
            rail.Current = i;
            rail.Invalidate();
            for (int k = 0; k < pages.Length; k++) pages[k].Visible = (k == i);
            UpdateButtons();
        }
        private void ShowPage(int i)
        {
            // direct jump (initial / install / done): just fade the new page in
            SwitchPage(i);
            fade = 1F;
            fadeToPage = -1;
            fadeActive = true;
            cardFade.Visible = true;
            cardFade.BringToFront();
        }
        private void Next()
        {
            if (page == 4) { BeginInstall(); return; }
            if (page == 5 || page == 6) return;
            if (fadeActive) return;
            // dissolve out the current page, then in the next — no text movement
            fadeToPage = page + 1;
            fadeActive = true;
            cardFade.Visible = true;
            cardFade.BringToFront();
        }
        private void Back()
        {
            if (page <= 0 || page == 5) return;
            if (fadeActive) return;
            fadeToPage = page - 1;
            fadeActive = true;
            cardFade.Visible = true;
            cardFade.BringToFront();
        }
        private void UpdateButtons()
        {
            btnBack.Visible = (page > 0 && page < 5);
            btnNext.Visible = (page < 5);
            switch (page)
            {
                case 0: btnNext.Text = "Продолжить"; btnNext.Enabled = true; break;
                case 1: btnNext.Text = "Продолжить"; SyncNext(); break;
                case 2: btnNext.Text = "Продолжить"; UpdateFreeSpace(); break;
                case 3: btnNext.Text = "Продолжить"; btnNext.Enabled = true; break;
                case 4: btnNext.Text = "Установить"; btnNext.Enabled = true; break;
                default: btnNext.Enabled = true; break;
            }
        }
        private void SyncNext()
        {
            if (page == 1) btnNext.Enabled = acceptCheck.Checked;
        }

        // ── install orchestration ───────────────────────────────────────────────
        private void BeginInstall()
        {
            if (installing) return;
            // elevation: if we can't write to the chosen path and we're not admin, relaunch elevated.
            if (!Installer.CanWriteToDir(cfg.InstallPath) && !Installer.IsElevated())
            {
                string cfgPath = Path.Combine(Path.GetTempPath(), "eh-cfg-" + Guid.NewGuid().ToString("N") + ".txt");
                cfg.AutoStart = true;
                Serialize.Write(cfgPath, cfg);
                Installer.RelaunchElevated(cfgPath);
                try { Close(); } catch { }
                return;
            }

            installing = true;
            ShowPage(5);
            btnNext.Visible = false; btnBack.Visible = false;

            Installer job = new Installer { C = cfg };
            job.Phase += (t, sub) => Invoke((Action)(() => { phaseLabel.Text = t; fileLabel.Text = sub; }));
            job.Log += (l) => Invoke((Action)(() => logBox.Append(l)));
            job.Progress += (pct, recv, total, speed, eta) => Invoke((Action)(() =>
            {
                prog.Value = pct;   // bar target — UiProgress lerps to it at 60fps
                // Throttle the text labels (~12/sec) so the UI thread isn't
                // flooded by WebClient.DownloadProgressChanged firing many times/sec.
                long now = Environment.TickCount;
                if (pct >= 100 || now - lastProgMs > 80)
                {
                    lastProgMs = now;
                    pctLabel.Text = pct + "%";
                    speedLabel.Text = "Скорость: " + (speed > 0 ? (speed / 1048576.0).ToString("0.0") + " МБ/с" : "—");
                    etaLabel.Text = "Осталось: " + (eta > 0 ? "~" + FormatEta(eta) : "—");
                }
            }));
            job.FileCur += (f) => Invoke((Action)(() => { fileLabel.Text = "Текущий файл: " + f; }));
            job.FileCount += (d, t) => Invoke((Action)(() => { fileCountLabel.Text = "Файлы: " + d + " из " + t; }));
            job.Fail += (m) => Invoke((Action)(() => OnFail(m)));
            job.Done += () => Invoke((Action)(() =>
            {
                installing = false;
                prog.Value = 100; pctLabel.Text = "100%";
                phaseLabel.Text = "Готово"; fileLabel.Text = "Установка завершена";
                ShowPage(6);
                if (cfg.LaunchOnFinish) LaunchApp();
            }));

            new Thread(new ThreadStart(job.Run)) { IsBackground = true }.Start();
        }
        private void OnFail(string msg)
        {
            installing = false;
            phaseLabel.Text = "Ошибка"; phaseLabel.ForeColor = C.Err;
            fileLabel.Text = msg;
            logBox.Append("[!] " + msg);
            // offer retry via a small action: re-enable next as "Повторить"
            btnNext.Visible = true; btnNext.Text = "Повторить"; btnNext.Enabled = true;
            btnNext.Click -= RetryHandler; btnNext.Click += RetryHandler;
        }
        private void RetryHandler(object s, EventArgs e) { btnNext.Click -= RetryHandler; btnNext.Text = "Установить"; phaseLabel.ForeColor = C.Text; BeginInstall(); }

        private static string FormatEta(double s)
        {
            if (s < 60) return Math.Ceiling(s) + " c";
            int m = (int)(s / 60); int ss = (int)(s % 60);
            return m + " мин " + ss + " c";
        }

        // ── animation timer (single 16ms loop drives everything) ────────────────
        private void AnimTick(object s, EventArgs e)
        {
            DateTime now = DateTime.UtcNow;
            float dt = Math.Min(0.05f, (float)(now - last).TotalSeconds);
            last = now;

            // Animated background: the sidebar + title bar paint their own
            // starfields each frame and read StarOX/StarOY, so they run at the
            // full frame rate (smooth cosmic drift / twinkle / meteors). The
            // form bg + content card + pages only repaint while the cursor
            // parallax is actually moving the starfield behind the translucent
            // card — and that repaint is throttled to ~60fps, because
            // re-rendering the page text every frame at the full rate was the lag
            // (60fps is smooth for a slow parallax drift).
            bgT += dt;
            UpdateParallax(dt);
            rail.Time = bgT;
            rail.Tick(dt);          // advance meteors / spawn timing
            title.Time = bgT;
            rail.Invalidate();
            title.Invalidate();
            if (parMoving && (now - lastFull).TotalSeconds >= 0.016)
            {
                lastFull = now;
                this.Invalidate(true);
            }

            // window fade: reveal on open, cover on close (no Form.Opacity / Mica)
            if (closing)
            {
                cover += dt * 6F;
                if (cover >= 1F) { cover = 1F; overlay.Invalidate(); DoPendingClose(); }
                else overlay.Invalidate();
            }
            else if (shown && cover > 0F)
            {
                cover -= dt * 5F;
                if (cover <= 0F) { cover = 0F; overlay.Visible = false; }
                else overlay.Invalidate();
            }

            trans.Step(dt);

            // Page transition: dissolve through the card color. Phase 1 fades
            // the veil up over the current page; at the top it swaps the page;
            // phase 2 fades the veil down to reveal the new one. No text moves.
            if (fadeActive)
            {
                if (fadeToPage >= 0)
                {
                    fade += dt * 5F;
                    if (fade >= 1F) { fade = 1F; SwitchPage(fadeToPage); fadeToPage = -1; }
                }
                else
                {
                    fade -= dt * 5F;
                    if (fade <= 0F) { fade = 0F; fadeActive = false; }
                }
                bool need = fade > 0.01F;
                if (need != cardFade.Visible) { cardFade.Visible = need; if (need) cardFade.BringToFront(); }
                if (need) cardFade.Invalidate();
            }

            TickControls(Controls, dt);
        }
        // Skip invisible subtrees (the 6 hidden wizard pages) so per-frame work
        // only touches the one visible page + chrome, not all 7 pages' children.
        private void TickControls(Control.ControlCollection cc, float dt)
        {
            foreach (Control c in cc)
            {
                if (!c.Visible) continue;
                if (c is UiButton) ((UiButton)c).Tick(dt);
                else if (c is UiCheck) ((UiCheck)c).Tick(dt);
                else if (c is UiProgress) ((UiProgress)c).Tick(dt);
                else if (c is ScrollTextView) ((ScrollTextView)c).Tick(dt);
                if (c.HasChildren) TickControls(c.Controls, dt);
            }
        }

        // ── window move / resize niceties ───────────────────────────────────────
        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ClassStyle |= 0x00020000; // CS_VREDRAW
                return cp;
            }
        }
    }

    // ── page slide transition (ease-out-quint: fast in, gentle settle) ──────────
    internal struct Transition
    {
        public Panel From, To;
        public float T;
        public int Dir;
        public int BaseX;
        public bool Active;
        private const float Span = 80F;   // slide distance (px)
        private const float Speed = 3.2F;  // ~0.31s at 60fps
        public void Start(Panel from, Panel to, int dir, int baseX)
        {
            From = from; To = to; Dir = dir; BaseX = baseX; T = 0; Active = true;
            // Reset positions so a re-trigger mid-flight leaves no leftover offset.
            if (From != null) From.Left = baseX;
            if (To != null) To.Left = baseX + (int)(dir * Span);
            to.Visible = true;
            from.Visible = true;
        }
        public void Step(float dt)
        {
            if (!Active) return;
            T += dt * Speed;
            if (T >= 1F) T = 1F;
            float e = Ease(T);
            if (From != null) From.Left = (int)(BaseX - Dir * Span * e);
            if (To != null) To.Left = (int)(BaseX + Dir * Span * (1 - e));
            if (T >= 1F)
            {
                if (To != null) To.Left = BaseX;
                if (From != null) { From.Visible = false; From.Left = 0; }
                Active = false;
            }
        }
        private static float Ease(float t) { return 1F - (float)Math.Pow(1F - t, 5F); } // ease-out-quint
    }

    // ── uninstall window (small) ────────────────────────────────────────────────
    internal sealed class UninstallForm : Form
    {
        private Installer job; private Label phase; private UiProgress prog; private ScrollTextView log; private UiButton finish;
        private System.Windows.Forms.Timer anim; private DateTime last = DateTime.UtcNow;
        private DbPanel overlay; private float cover = 1F; private bool shown, closing; private Action pendingClose;

        public UninstallForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(520, 360);
            BackColor = C.Bg;
            DoubleBuffered = true;
            ShowInTaskbar = true;
            Text = "Удаление Editor Helper";

            title = new Titlebar { Bounds = new Rectangle(0, 0, 520, 40) };
            title.OnClose = () => { if (!busy) FadeClose(() => Close()); };
            title.OnMinimize = () => { };
            Controls.Add(title);

            phase = new Label { AutoSize = false, Bounds = new Rectangle(34, 60, 452, 30), Font = F.H1, ForeColor = C.Text, BackColor = Color.Transparent, Text = "Удаление Editor Helper" };
            prog = new UiProgress { Bounds = new Rectangle(34, 104, 452, 14) };
            log = new ScrollTextView { Bounds = new Rectangle(34, 140, 452, 150) };
            log.Font = F.Mono;
            finish = new UiButton { Kind = BtnKind.Primary, Text = "Закрыть", Bounds = new Rectangle(346, 300, 140, 42) };
            finish.Enabled = false;
            finish.Click += (s, e) => FadeClose(() => Close());
            Controls.Add(phase); Controls.Add(prog); Controls.Add(log); Controls.Add(finish);

            overlay = new DbPanel { Bounds = new Rectangle(0, 0, 520, 360), BackColor = Color.Transparent };
            overlay.Paint += (s, e) =>
            {
                if (cover > 0.01F)
                    using (SolidBrush b = new SolidBrush(Color.FromArgb((int)(cover * 255), C.Bg)))
                        e.Graphics.FillRectangle(b, overlay.ClientRectangle);
            };
            Controls.Add(overlay);
            overlay.BringToFront();

            anim = new System.Windows.Forms.Timer { Interval = 2 };
            anim.Tick += (s, e) =>
            {
                DateTime n = DateTime.UtcNow; float dt = Math.Min(0.05f, (float)(n - last).TotalSeconds); last = n;
                if (closing) { cover += dt * 6F; if (cover >= 1F) { cover = 1F; overlay.Invalidate(); DoPendingClose(); } else overlay.Invalidate(); }
                else if (shown && cover > 0F) { cover -= dt * 5F; if (cover <= 0F) { cover = 0F; overlay.Visible = false; } else overlay.Invalidate(); }
                prog.Tick(dt); finish.Tick(dt); log.Tick(dt);
            };
            anim.Start();

            Load += (s, e) => Chrome.Apply(Handle);
            Shown += (s, e) => { shown = true; Start(); };
        }
        private Titlebar title; private bool busy = true;

        private void FadeClose(Action after) { if (closing) return; closing = true; pendingClose = after; if (!overlay.Visible) overlay.Visible = true; }
        private void DoPendingClose() { Action a = pendingClose; pendingClose = null; if (a == null) { try { Close(); } catch { } return; } try { a(); } catch { } }

        private void Start()
        {
            job = new Installer { C = new Cfg { InstallPath = Installer.ReadRegistryStatic(Installer.RegUninstall, "InstallLocation") } };
            job.Phase += (t, sub) => Invoke((Action)(() => { phase.Text = t; prog.Value = prog.Value < 40 ? 40 : prog.Value; }));
            job.Log += (l) => Invoke((Action)(() => { log.Append(l); prog.Value = Math.Min(95, prog.Value + 6); }));
            job.Done += () => Invoke((Action)(() => { prog.Value = 100; phase.Text = "Удаление завершено"; finish.Enabled = true; busy = false; }));
            job.Fail += (m) => Invoke((Action)(() => { phase.Text = "Ошибка удаления"; log.Append("[!] " + m); finish.Enabled = true; busy = false; }));
            new Thread(new ThreadStart(job.Uninstall)) { IsBackground = true }.Start();
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            using (LinearGradientBrush lb = new LinearGradientBrush(ClientRectangle, Hex2("#060610"), Hex2("#030305"), 90F))
                e.Graphics.FillRectangle(lb, ClientRectangle);
        }
        private static Color Hex2(string s) { return C.Hex(s); }
    }

    // ── embedded MIT license ───────────────────────────────────────────────────
    internal static class LicenseText
    {
        public const string Text =
@"MIT License

Copyright (c) 2026 dekixh

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the ""Software""), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED ""AS IS"", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

Editor Helper — приложение для установки плагинов, скриптов и пресетов
для Adobe After Effects. Установщик загружает последнюю версию из
GitHub Releases репозитория dekixh/Editor-Helper-Lite.";
    }
}