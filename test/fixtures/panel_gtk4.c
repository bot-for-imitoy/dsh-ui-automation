/* panel_gtk4.c — GTK4 fixture for dsh-ui-automation.
 *
 * Same counters as the Qt/GTK3 panels (clicks / checked / text). GTK 4.24 on
 * X11 reports (0,0,w,h) extents for every widget over AT-SPI, so this fixture is
 * also the reproducible evidence for the plugin's E_NO_GEOMETRY guard: the
 * numbered-image contract needs real rectangles.
 *
 * Build:
 *   gcc -O1 panel_gtk4.c -o panel_gtk4 $(pkg-config --cflags --libs gtk4)
 */
#include <gtk/gtk.h>
#include <stdio.h>
#include <stdlib.h>

static GtkWidget *g_entry, *g_check, *g_status;
static int g_clicks;

static void refresh(void)
{
    const char *txt = gtk_editable_get_text(GTK_EDITABLE(g_entry));
    char *s = g_strdup_printf("clicks=%d checked=%s text='%s'", g_clicks,
                              gtk_check_button_get_active(GTK_CHECK_BUTTON(g_check)) ? "true" : "false",
                              txt);
    gtk_label_set_text(GTK_LABEL(g_status), s);
    printf("%s\n", s);
    fflush(stdout);
    g_free(s);
}

static void on_click(GtkButton *b, gpointer d)
{
    (void)b; (void)d;
    g_clicks++;
    refresh();
}

static void on_toggle(GtkCheckButton *t, gpointer d)
{
    (void)t; (void)d;
    refresh();
}

static void on_changed(GtkEditable *e, gpointer d)
{
    (void)e; (void)d;
    refresh();
}

static void name_widget(GtkWidget *w, const char *name)
{
    gtk_accessible_update_property(GTK_ACCESSIBLE(w), GTK_ACCESSIBLE_PROPERTY_LABEL, name, -1);
}

static void draw_gray(GtkDrawingArea *w, cairo_t *cr, int width, int height, gpointer d)
{
    (void)w; (void)d; (void)width; (void)height;
    cairo_set_source_rgb(cr, 0.85, 0.85, 0.85);
    cairo_paint(cr);
}

int main(int argc, char **argv)
{
    g_set_prgname("panel_gtk4");
    gtk_init();

    GtkWidget *win = gtk_window_new();
    gtk_window_set_title(GTK_WINDOW(win), "GTK4 Panel");
    gtk_window_set_default_size(GTK_WINDOW(win), 460, 420);

    GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 6);
    gtk_widget_set_margin_start(box, 8);
    gtk_widget_set_margin_end(box, 8);
    gtk_widget_set_margin_top(box, 8);
    gtk_window_set_child(GTK_WINDOW(win), box);

    g_entry = gtk_entry_new();
    gtk_entry_set_placeholder_text(GTK_ENTRY(g_entry), "type here");
    name_widget(g_entry, "input");
    gtk_box_append(GTK_BOX(box), g_entry);

    GtkWidget *btn = gtk_button_new_with_label("点击 Click");
    name_widget(btn, "button");
    g_signal_connect(btn, "clicked", G_CALLBACK(on_click), NULL);
    gtk_box_append(GTK_BOX(box), btn);

    g_check = gtk_check_button_new_with_label("勾选 Check");
    name_widget(g_check, "check");
    g_signal_connect(g_check, "toggled", G_CALLBACK(on_toggle), NULL);
    gtk_box_append(GTK_BOX(box), g_check);

    GtkWidget *area = gtk_drawing_area_new();
    gtk_widget_set_size_request(area, -1, 120);
    gtk_drawing_area_set_draw_func(GTK_DRAWING_AREA(area), draw_gray, NULL, NULL);
    gtk_box_append(GTK_BOX(box), area);

    g_status = gtk_label_new("");
    gtk_box_append(GTK_BOX(box), g_status);

    g_signal_connect(g_entry, "changed", G_CALLBACK(on_changed), NULL);

    gtk_window_present(GTK_WINDOW(win));
    refresh();
    GMainLoop *loop = g_main_loop_new(NULL, FALSE);
    g_main_loop_run(loop);
    return 0;
}
