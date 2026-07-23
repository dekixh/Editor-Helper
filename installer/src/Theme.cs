// installer/src/Theme.cs — design tokens + GDI helpers + a tiny tween engine.
// Mirrors ui/styles.css (:root) so the installer looks like the app itself.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace EhSetup
{
    // ── Color tokens — black/monochrome theme (#08080A / #0C0C0F / white accent) ──
    internal static class C
    {
        public static readonly Color Bg = Hex("#08080A");
        public static readonly Color Bg2 = Hex("#050507");
        public static readonly Color SurfaceSolid = Hex("#141418");
        public static readonly Color Surface = Argb(128, 20, 20, 24);      // translucent panel
        public static readonly Color SurfaceHi = Argb(150, 30, 30, 36);
        public static readonly Color SurfaceTop = Argb(176, 42, 42, 50);
        public static readonly Color Border = Argb(22, 255, 255, 255);     // rgba(255,255,255,.08) — minimal
        public static readonly Color BorderHi = Argb(42, 255, 255, 255);
        public static readonly Color BorderNeon = Argb(90, 255, 255, 255); // white-tinted
        public static readonly Color GlassEdge = Argb(18, 255, 255, 255);
        public static readonly Color Text = Hex("#F4F4F6");
        public static readonly Color TextDim = Hex("#ACACB4");
        public static readonly Color TextMute = Hex("#6E6E76");
        // Accent — white/silver monochrome (#FFFFFF -> #C8C8D0). "Black theme":
        // very dark bg + a light accent, no orange. Matches the app identity.
        public static readonly Color Accent = Hex("#F4F4F6");              // white
        public static readonly Color Accent2 = Hex("#C8C8D0");            // gradient bottom (silver)
        public static readonly Color AccentHi = Hex("#FFFFFF");          // gradient top (white)
        public static readonly Color OnAccent = Hex("#0A0A0C");           // dark text on white
        public static readonly Color AccentSoft = Argb(26, 255, 255, 255); // white 10%
        public static readonly Color Err = Hex("#E07070");
        public static readonly Color ErrHi = Argb(89, 224, 112, 112);
        public static readonly Color Ok = Hex("#C8C8D0");
        // Opaque black card face — the content card is solid (no starfield
        // bleeds through), which is the "black" in the black theme and keeps
        // the animated background from forcing the pages to repaint.
        public static readonly Color CardFace = Hex("#0C0C0F");

        public static Color Hex(string s)
        {
            s = s.TrimStart('#');
            int r = Convert.ToInt32(s.Substring(0, 2), 16);
            int g = Convert.ToInt32(s.Substring(2, 2), 16);
            int b = Convert.ToInt32(s.Substring(4, 2), 16);
            return Color.FromArgb(r, g, b);
        }
        public static Color Argb(int a, int r, int g, int b) { return Color.FromArgb(a, r, g, b); }
    }

    // ── Fonts (Segoe UI = the Windows member of the app's Inter/Segoe UI stack) ──
    internal static class F
    {
        public static Font Title = new Font("Segoe UI", 26F, FontStyle.Bold, GraphicsUnit.Pixel);
        public static Font H1 = new Font("Segoe UI", 21F, FontStyle.Bold, GraphicsUnit.Pixel);
        public static Font H2 = new Font("Segoe UI", 14F, FontStyle.Bold, GraphicsUnit.Pixel);
        public static Font Body = new Font("Segoe UI", 13F, FontStyle.Regular, GraphicsUnit.Pixel);
        public static Font BodyB = new Font("Segoe UI", 13F, FontStyle.Bold, GraphicsUnit.Pixel);
        public static Font Small = new Font("Segoe UI", 11F, FontStyle.Regular, GraphicsUnit.Pixel);
        public static Font SmallB = new Font("Segoe UI", 11F, FontStyle.Bold, GraphicsUnit.Pixel);
        public static Font Tiny = new Font("Segoe UI", 10F, FontStyle.Regular, GraphicsUnit.Pixel);
        public static Font Mono = new Font("Cascadia Mono", 11F, FontStyle.Regular, GraphicsUnit.Pixel);
        public static Font Button = new Font("Segoe UI", 13F, FontStyle.Bold, GraphicsUnit.Pixel);
    }

    // ── Shape ───────────────────────────────────────────────────────────────────
    internal static class S
    {
        public const int Radius = 18;
        public const int RadiusSm = 12;
        public const int RadiusXs = 8;
    }

    // ── GDI helpers ──────────────────────────────────────────────────────────────
    internal static class G
    {
        // Builds a rounded-rectangle path. radius <= 0 (or a degenerate rect)
        // yields a plain rectangle — sharp corners, exactly what radius 0 means.
        // Never emits AddArc with a zero width/height: GDI+ AddArc throws
        // ArgumentException ("Parameter is not valid") for d == 0, which crashed
        // the installer on first paint (flat sidebar uses radius 0).
        public static GraphicsPath Round(Rectangle r, int radius)
        {
            GraphicsPath p = new GraphicsPath();
            if (r.Width <= 0 || r.Height <= 0) { p.AddRectangle(r); return p; }
            if (radius <= 0) { p.AddRectangle(r); return p; }
            int d = radius * 2;
            if (d > r.Width) d = r.Width;
            if (d > r.Height) d = r.Height;
            radius = d / 2;
            if (radius < 1) { p.AddRectangle(r); return p; }
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        public static void FillRound(Graphics g, Rectangle r, int radius, Color fill)
        {
            if (r.Width <= 0 || r.Height <= 0) return;
            using (GraphicsPath p = Round(r, radius))
            using (SolidBrush br = new SolidBrush(fill))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.FillPath(br, p);
            }
        }

        public static void DrawRound(Graphics g, Rectangle r, int radius, Color border, float width)
        {
            if (r.Width <= 0 || r.Height <= 0) return;
            r.Width -= 1; r.Height -= 1;
            using (GraphicsPath p = Round(r, radius))
            using (Pen pen = new Pen(border, width))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.DrawPath(pen, p);
            }
        }

        // A glass panel: translucent dark fill, subtle top highlight, hairline border.
        public static void Glass(Graphics g, Rectangle r, int radius)
        {
            if (r.Width <= 0 || r.Height <= 0) return;
            using (GraphicsPath p = Round(r, radius))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using (SolidBrush br = new SolidBrush(C.Surface))
                    g.FillPath(br, p);
                // top sheen (LinearGradientBrush throws on a 0-height rect, so guard it)
                if (r.Height >= 4 && r.Width >= 1)
                {
                    Rectangle sheen = new Rectangle(r.X, r.Y, r.Width, r.Height / 2);
                    using (LinearGradientBrush lb = new LinearGradientBrush(sheen, Argb(38, 255, 255, 255), Argb(0, 255, 255, 255), 90F))
                    {
                        Region old = g.Clip;
                        using (Region clip = new Region(p))
                        {
                            g.Clip = clip;
                            g.FillRectangle(lb, sheen);
                            g.Clip = old;
                        }
                    }
                }
                using (Pen pen = new Pen(C.Border, 1F)) g.DrawPath(pen, p);
            }
        }

        public static Color Argb(int a, int r, int gg, int b) { return Color.FromArgb(a, r, gg, b); }

        // A content card: translucent dark fill, soft outer shadow, top sheen,
        // hairline border. Drawn ONCE into the cached background, so it is free
        // at runtime.
        public static void Card(Graphics g, Rectangle r, int radius)
        {
            if (r.Width <= 0 || r.Height <= 0) return;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            // soft drop shadow (stacked translucent rounded rects, offset down)
            for (int i = 0; i < 5; i++)
            {
                Rectangle s = r; s.Y += 2 + i; s.X += i / 2;
                using (GraphicsPath p = Round(s, radius))
                using (SolidBrush b = new SolidBrush(Color.FromArgb(8, 0, 0, 0)))
                    g.FillPath(b, p);
            }
            using (GraphicsPath p = Round(r, radius))
            {
                // Translucent dark fill — the card is a glass panel: the
                // starfield shows through it (semi-transparent). It is drawn
                // over the static bg, so the transparent content on top never
                // needs to repaint for the background — the sidebar still
                // carries the animation.
                using (SolidBrush br = new SolidBrush(Color.FromArgb(168, 14, 14, 18)))
                    g.FillPath(br, p);
                // top sheen
                if (r.Height >= 8)
                {
                    Rectangle sheen = new Rectangle(r.X, r.Y, r.Width, r.Height / 2);
                    using (LinearGradientBrush lb = new LinearGradientBrush(sheen, Argb(22, 255, 255, 255), Argb(0, 255, 255, 255), 90F))
                    {
                        Region old = g.Clip;
                        using (Region clip = new Region(p)) { g.Clip = clip; g.FillRectangle(lb, sheen); g.Clip = old; }
                    }
                }
                using (Pen pen = new Pen(C.BorderHi, 1F)) g.DrawPath(pen, p);
            }
        }

        // Soft outer glow around a rounded rect (amber for accent elements).
        public static void GlowRound(Graphics g, Rectangle r, int radius, Color glow, int strength)
        {
            if (r.Width <= 0 || r.Height <= 0 || strength <= 0) return;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            for (int i = strength; i > 0; i--)
            {
                Rectangle e = r; e.Inflate(i, i);
                int a = (int)(glow.A * (0.10F * (strength - i + 1) / strength));
                if (a <= 0) continue;
                using (GraphicsPath p = Round(e, radius + i))
                using (Pen pen = new Pen(Color.FromArgb(a, glow.R, glow.G, glow.B), 1.4F))
                    g.DrawPath(pen, p);
            }
        }

        public static Color Mix(Color a, Color b, float t)
        {
            if (t < 0) t = 0; if (t > 1) t = 1;
            return Color.FromArgb(
                (int)(a.A + (b.A - a.A) * t),
                (int)(a.R + (b.R - a.R) * t),
                (int)(a.G + (b.G - a.G) * t),
                (int)(a.B + (b.B - a.B) * t));
        }

        // Accent gradient (white -> silver) at 135deg, like --accent-grad.
        public static Brush AccentBrush(Rectangle r)
        {
            LinearGradientBrush lb = new LinearGradientBrush(r, C.AccentHi, C.Accent2, 135F);
            return lb;
        }

        public static void TextCenter(Graphics g, string s, Font f, Color col, Rectangle r)
        {
            using (SolidBrush br = new SolidBrush(col))
            {
                StringFormat sf = new StringFormat();
                sf.Alignment = StringAlignment.Center;
                sf.LineAlignment = StringAlignment.Center;
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
                g.DrawString(s, f, br, r, sf);
            }
        }

        public static void TextLeft(Graphics g, string s, Font f, Color col, Rectangle r, bool wrap)
        {
            using (SolidBrush br = new SolidBrush(col))
            {
                StringFormat sf = new StringFormat();
                sf.Alignment = StringAlignment.Near;
                sf.LineAlignment = StringAlignment.Near;
                if (wrap) sf.FormatFlags = 0;
                else sf.FormatFlags = StringFormatFlags.NoWrap;
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
                g.DrawString(s, f, br, r, sf);
            }
        }
    }

    // ── Tween engine: drives hover/press/transition animations on one timer ──────
    internal sealed class Tween
    {
        public float From, To, Value, Speed;
        public bool Done;
        public Tween(float v) { From = v; To = v; Value = v; Speed = 14F; Done = true; }
        public void To_(float t) { From = Value; To = t; Done = Math.Abs(To - From) < 0.001f; }
        public void Step(float dt)
        {
            if (Done) return;
            float k = Math.Min(1F, Speed * dt);
            Value += (To - Value) * k;
            if (Math.Abs(To - Value) < 0.01f) { Value = To; Done = true; }
        }
    }

    // ── Window chrome: dark title bar + rounded corners + OS shadow ──────────────
    internal static class Chrome
    {
        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
        public const int WA_USE_IMMERSIVE_DARK_MODE = 20;
        public const int WA_BORDER_CORNER = 33;     // DWMWA_WINDOW_CORNER_PREFERENCE
        public const int WA_SYSTEMBACKDROP = 38;    // DWMWA_SYSTEMBACKDROP_TYPE (Mica/Acrylic, Win11 22H2+)
        public const int CORNER_ROUND = 2;
        public const int BACKDROP_MICA = 2;

        public static void Apply(IntPtr hwnd)
        {
            try
            {
                int dark = 1;
                DwmSetWindowAttribute(hwnd, WA_USE_IMMERSIVE_DARK_MODE, ref dark, 4);
                int round = CORNER_ROUND;
                DwmSetWindowAttribute(hwnd, WA_BORDER_CORNER, ref round, 4);
                int bd = BACKDROP_MICA;
                DwmSetWindowAttribute(hwnd, WA_SYSTEMBACKDROP, ref bd, 4);
            }
            catch { }
        }
    }

    // ── DPI awareness (keep custom painting crisp) ───────────────────────────────
    internal static class Dpi
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();
        private static bool _done;
        public static void Aware()
        {
            if (_done) return;
            try { SetProcessDPIAware(); } catch { }
            _done = true;
        }
        public static float Scale = 1F;
    }
}