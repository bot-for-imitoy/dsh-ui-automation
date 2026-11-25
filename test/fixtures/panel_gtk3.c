/* panel_gtk3.c — GTK3 test panel for the dsh-ui-automation plugin tests.
 *
 * Mirrors panel_qt.cpp: named widgets plus double-click, drag and wheel
 * counters published through a status label that the driver reads back over
 * AT-SPI.
 *
 * Build:
 *   gcc -O1 panel_gtk3.c -o panel_gtk3 $(pkg-config --cflags --libs gtk+-3.0)
 */
#include <gtk/gtk.h>
#include <stdio.h>
#include <stdlib.h>

static int g_clicks, g_dclicks, g_drags, g_dragdist, g_moves;
static int g_wheelticks, g_wheeldelta;
static int g_pressx = -1, g_pressy = -1, g_releasex = -1, g_releasey = -1;
static GtkWidget *g_entry, *g_check, *g_status;

static void refresh(void)
{
    const char *txt = gtk_entry_get_text(GTK_ENTRY(g_entry));
    char *s = g_strdup_printf(
        "clicks=%d dclicks=%d drags=%d dragdist=%d moves=%d wheel=%d "
        "wheelTicks=%d checked=%s text='%s'",
        g_clicks, g_dclicks, g_drags, g_dragdist, g_moves, g_wheeldelta,
        g_wheelticks,
        gtk_toggle_button_get_active(GTK_TOGGLE_BUTTON(g_check)) ? "true" : "false",
        txt);
    gtk_label_set_text(GTK_LABEL(g_status), s);
    printf("%s\n", s);
    fflush(stdout);
    g_free(s);
}

static void on_click(GtkButton *b, gpointer d) { (void)b; (void)d; g_clicks++; refresh(); }
static void on_toggle(GtkToggleButton *t, gpointer d) { (void)t; (void)d; refresh(); }
static void on_changed(GtkEditable *e, gpointer d) { (void)e; (void)d; refresh(); }

static void name_widget(GtkWidget *w, const char *name)
{
    AtkObject *ao = gtk_widget_get_accessible(w);
    if (ao)
        atk_object_set_name(ao, name);
}

static gboolean on_drag_press(GtkWidget *w, GdkEventButton *e, gpointer d)
{
    (void)w; (void)d;
    g_pressx = (int)e->x;
    g_pressy = (int)e->y;
    g_releasex = -1;
    g_releasey = -1;
    g_moves = 0;
    refresh();
    return TRUE;
}

static gboolean on_drag_motion(GtkWidget *w, GdkEventMotion *e, gpointer d)
{
    (void)w; (void)d;
    if (e->state & GDK_BUTTON1_MASK) {
        g_moves++;
        g_releasex = (int)e->x;
        g_releasey = (int)e->y;
        refresh();
    }
    return TRUE;
}

static gboolean on_drag_release(GtkWidget *w, GdkEventButton *e, gpointer d)
{
    (void)w; (void)d;
    g_releasex = (int)e->x;
    g_releasey = (int)e->y;
    g_drags++;
    g_dragdist += abs(g_releasex - g_pressx) + abs(g_releasey - g_pressy);
    refresh();
    return TRUE;
}

static gboolean on_dbl_press(GtkWidget *w, GdkEventButton *e, gpointer d)
{
    (void)w; (void)d;
    if (e->type == GDK_2BUTTON_PRESS) {
        g_dclicks++;
        refresh();
        return TRUE;
    }
    return FALSE;
}

static gboolean on_scroll(GtkWidget *w, GdkEventScroll *e, gpointer d)
{
    (void)w; (void)d;
    g_wheelticks++;
    if (e->direction == GDK_SCROLL_UP || e->direction == GDK_SCROLL_LEFT)
        g_wheeldelta += 120;
    else if (e->direction == GDK_SCROLL_DOWN || e->direction == GDK_SCROLL_RIGHT)
        g_wheeldelta -= 120;
    refresh();
    return TRUE;
}

static gboolean draw_gray(GtkWidget *w, cairo_t *cr, gpointer d)
{
    (void)d;
    GtkAllocation alloc;
    gtk_widget_get_allocation(w, &alloc);
    cairo_set_source_rgb(cr, 0.85, 0.85, 0.85);
    cairo_paint(cr);
    (void)alloc;
    return FALSE;
}

static GtkWidget *make_area(const char *name, int h)
{
    GtkWidget *da = gtk_drawing_area_new();
    gtk_widget_set_size_request(da, -1, h);
    gtk_widget_add_events(da,
        GDK_BUTTON_PRESS_MASK | GDK_BUTTON_RELEASE_MASK |
        GDK_POINTER_MOTION_MASK | GDK_SCROLL_MASK);
    g_signal_connect(da, "draw", G_CALLBACK(draw_gray), NULL);
    name_widget(da, name);
    return da;
}

int main(int argc, char **argv)
{
    gtk_init(&argc, &argv);

    GtkWidget *win = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_title(GTK_WINDOW(win), "GTK3 Panel");
    gtk_window_set_default_size(GTK_WINDOW(win), 460, 460);
    g_signal_connect(win, "destroy", G_CALLBACK(gtk_main_quit), NULL);

    GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 6);
    gtk_container_set_border_width(GTK_CONTAINER(box), 8);
    gtk_container_add(GTK_CONTAINER(win), box);

    g_entry = gtk_entry_new();
    gtk_entry_set_placeholder_text(GTK_ENTRY(g_entry), "type here");
    name_widget(g_entry, "input");
    gtk_box_pack_start(GTK_BOX(box), g_entry, FALSE, FALSE, 0);

    GtkWidget *btn = gtk_button_new_with_label("点击 Click");
    name_widget(btn, "button");
    g_signal_connect(btn, "clicked", G_CALLBACK(on_click), NULL);
    gtk_box_pack_start(GTK_BOX(box), btn, FALSE, FALSE, 0);

    g_check = gtk_check_button_new_with_label("勾选 Check");
    name_widget(g_check, "check");
    g_signal_connect(g_check, "toggled", G_CALLBACK(on_toggle), NULL);
    gtk_box_pack_start(GTK_BOX(box), g_check, FALSE, FALSE, 0);

    GtkWidget *drag = make_area("dragarea", 56);
    g_signal_connect(drag, "button-press-event", G_CALLBACK(on_drag_press), NULL);
    g_signal_connect(drag, "motion-notify-event", G_CALLBACK(on_drag_motion), NULL);
    g_signal_connect(drag, "button-release-event", G_CALLBACK(on_drag_release), NULL);
    gtk_box_pack_start(GTK_BOX(box), drag, FALSE, FALSE, 0);

    GtkWidget *dbl = make_area("dblarea", 48);
    g_signal_connect(dbl, "button-press-event", G_CALLBACK(on_dbl_press), NULL);
    gtk_box_pack_start(GTK_BOX(box), dbl, FALSE, FALSE, 0);

    GtkWidget *wheel = make_area("wheelarea", 48);
    g_signal_connect(wheel, "scroll-event", G_CALLBACK(on_scroll), NULL);
    gtk_box_pack_start(GTK_BOX(box), wheel, FALSE, FALSE, 0);

    g_status = gtk_label_new("");
    gtk_box_pack_start(GTK_BOX(box), g_status, FALSE, FALSE, 0);

    g_signal_connect(g_entry, "changed", G_CALLBACK(on_changed), NULL);

    gtk_widget_show_all(win);
    refresh();
    gtk_main();
    return 0;
}
