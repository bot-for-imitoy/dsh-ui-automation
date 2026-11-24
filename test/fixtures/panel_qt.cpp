// panel_qt.cpp — Qt 6 test panel for the dsh-ui-automation plugin tests.
//
// Same idea as the research probe app (every widget has an accessible name and
// every state change is mirrored into a status label), plus the three counters
// the plugin's own tools need to prove: double click, drag and wheel.
//
// Build:
//   g++ -fPIC -O1 panel_qt.cpp -o panel_qt $(pkg-config --cflags --libs Qt6Widgets)
#include <QApplication>
#include <QWidget>
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QLineEdit>
#include <QPushButton>
#include <QCheckBox>
#include <QLabel>
#include <QMouseEvent>
#include <QWheelEvent>
#include <QDebug>
#include <cmath>
#include <functional>

static void nameIt(QWidget *w, const char *name)
{
    w->setAccessibleName(QString::fromUtf8(name));
}

class DragArea : public QWidget {
public:
    int drags = 0;
    int dist = 0;
    int moves = 0;
    int pressX = -1;
    int releaseX = -1;
    std::function<void()> onChange;
    explicit DragArea(QWidget *p) : QWidget(p)
    {
        setMinimumHeight(56);
        setStyleSheet(QStringLiteral("background:#d8d8d8;"));
        nameIt(this, "dragarea");
    }
protected:
    void mousePressEvent(QMouseEvent *e) override
    {
        pressX = int(e->position().x());
        releaseX = -1;
        moves = 0;
        if (onChange) onChange();
    }
    void mouseMoveEvent(QMouseEvent *e) override
    {
        if (e->buttons() & Qt::LeftButton) {
            moves++;
            releaseX = int(e->position().x());
            if (onChange) onChange();
        }
    }
    void mouseReleaseEvent(QMouseEvent *e) override
    {
        releaseX = int(e->position().x());
        drags++;
        dist += std::abs(releaseX - pressX);
        if (onChange) onChange();
    }
};

class DblArea : public QWidget {
public:
    int dclicks = 0;
    std::function<void()> onChange;
    explicit DblArea(QWidget *p) : QWidget(p)
    {
        setMinimumHeight(48);
        setStyleSheet(QStringLiteral("background:#e8e8e8;"));
        nameIt(this, "dblarea");
    }
protected:
    void mouseDoubleClickEvent(QMouseEvent *) override
    {
        dclicks++;
        if (onChange) onChange();
    }
};

class WheelArea : public QWidget {
public:
    int wheelTicks = 0;
    int wheelDelta = 0;
    std::function<void()> onChange;
    explicit WheelArea(QWidget *p) : QWidget(p)
    {
        setMinimumHeight(48);
        setStyleSheet(QStringLiteral("background:#f0f0f0;"));
        nameIt(this, "wheelarea");
    }
protected:
    void wheelEvent(QWheelEvent *e) override
    {
        wheelTicks++;
        wheelDelta += e->angleDelta().y();
        if (onChange) onChange();
    }
};

int main(int argc, char **argv)
{
    QApplication app(argc, argv);

    QWidget w;
    w.setWindowTitle(QStringLiteral("Qt Panel"));
    auto *v = new QVBoxLayout(&w);

    auto *input = new QLineEdit(&w);
    nameIt(input, "input");
    input->setPlaceholderText(QStringLiteral("type here"));
    v->addWidget(input);

    auto *btn = new QPushButton(QStringLiteral("点击 Click"), &w);
    nameIt(btn, "button");
    v->addWidget(btn);

    auto *chk = new QCheckBox(QStringLiteral("勾选 Check"), &w);
    nameIt(chk, "check");
    v->addWidget(chk);

    auto *drag = new DragArea(&w);
    v->addWidget(drag);
    auto *dbl = new DblArea(&w);
    v->addWidget(dbl);
    auto *wheel = new WheelArea(&w);
    v->addWidget(wheel);

    // The label carries the status text as its accessible name (a QLabel with
    // no accessibleName exposes its text), which is what the driver reads back.
    auto *status = new QLabel(&w);
    v->addWidget(status);

    int clicks = 0;
    auto refresh = [&]() {
        status->setText(QStringLiteral(
            "clicks=%1 dclicks=%2 drags=%3 dragdist=%4 moves=%5 wheel=%6 "
            "wheelTicks=%7 checked=%8 text='%9'")
            .arg(clicks).arg(dbl->dclicks).arg(drag->drags).arg(drag->dist)
            .arg(drag->moves).arg(wheel->wheelDelta).arg(wheel->wheelTicks)
            .arg(chk->isChecked() ? QStringLiteral("true") : QStringLiteral("false"))
            .arg(input->text()));
        qInfo().noquote() << status->text();
    };
    drag->onChange = refresh;
    dbl->onChange = refresh;
    wheel->onChange = refresh;

    QObject::connect(btn, &QPushButton::clicked, [&]() { clicks++; refresh(); });
    QObject::connect(chk, &QCheckBox::toggled, [&]() { refresh(); });
    QObject::connect(input, &QLineEdit::textChanged, [&]() { refresh(); });

    w.resize(460, 460);
    w.show();
    refresh();
    return app.exec();
}
