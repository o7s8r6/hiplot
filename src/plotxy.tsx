/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import $ from "jquery";
import * as d3 from "d3";

import { create_d3_scale } from "./infertypes";
import style from "./hiplot.css";
import { HiPlotPluginData } from "./plugin";
import React from "react";
import { ResizableH } from "./lib/resizable";
import _ from "underscore";
import { Datapoint } from "./types";


// DISPLAYS_DATA_DOC_BEGIN
// Corresponds to values in the dict of `exp._displays[hip.Displays.XY]`
export interface PlotXYDisplayData {
  axis_x: string | null,
  axis_y: string | null,
  lines_thickness: number;
  lines_opacity: number;
  dots_thickness: number;
  dots_opacity: number;

  // Default height in pixels
  height?: number;
};
// DISPLAYS_DATA_DOC_END

interface PlotXYProps extends HiPlotPluginData, PlotXYDisplayData {
};

interface PlotXYState extends PlotXYDisplayData {
  width: number,
  initialHeight: number,
  height: number,
  enabled: boolean,
};

interface PlotXYInternal {
  clear_canvas: () => void;
  update_axis: () => void;
  recompute_scale: () => void;
  draw_selected_rows: () => void;
  draw_highlighted: () => void;
};


export class PlotXY extends React.Component<PlotXYProps, PlotXYState> {
  on_resize: () => void = null;

  plot: PlotXYInternal;

  svg: any;

  root_ref: React.RefObject<HTMLDivElement> = React.createRef();
  container_ref: React.RefObject<HTMLDivElement> = React.createRef();
  canvas_lines_ref: React.RefObject<HTMLCanvasElement> = React.createRef();
  canvas_highlighted_ref: React.RefObject<HTMLCanvasElement> = React.createRef();

  constructor(props: PlotXYProps) {
    super(props);
    let height: number;
    if (props.window_state.height) {
      height = props.window_state.height;
    } else if (props.height) {
      height = props.height;
    } else {
      height = d3.min([d3.max([document.body.clientHeight-540, 240]), 500]);
    }

    // Load default X/Y axis
    const plotConfig = props.experiment._displays[this.props.name] as PlotXYDisplayData;
    function get_default_axis(axis_name) {
      var value = props.persistent_state.get(axis_name, props[axis_name]);
      if (value === undefined) {
        value = null;
      }
      if (value != null && props.params_def[value] === undefined) {
          return null;
      }
      return value;
    }

    const state = {
      ...plotConfig,
      axis_x: get_default_axis('axis_x'),
      axis_y: get_default_axis('axis_y'),
      width: 0,
      height: height,
      initialHeight: height
    };
    this.state = {
      ...state,
      enabled: state.axis_x !== null && state.axis_y !== null,
    };
  }
  static defaultProps = {
      axis_x: null,
      axis_y: null,
      lines_thickness: 1.2,
      lines_opacity: null,
      dots_thickness: 1.4,
      dots_opacity: null,

      data: {},
  }
  componentDidMount() {
    if (this.props.context_menu_ref && this.props.context_menu_ref.current) {
      const me = this;
      this.props.context_menu_ref.current.addCallback(function(column, cm) {
        var contextmenu = $(cm);
        contextmenu.append($('<div class="dropdown-divider"></div>'));
        contextmenu.append($(`<h6 class="dropdown-header">${me.props.name}</h6>`));
        ['axis_x', 'axis_y'].forEach(function(dat, index) {
          var label = "Set as " + ['X', 'Y'][index] + ' axis';
          var option = $('<a class="dropdown-item" href="#">').text(label);
          if (me.state[dat] == column) {
            option.addClass('disabled').css('pointer-events', 'none');
          }
          option.click(function(event) {
            if (index == 0) {
              me.setState({axis_x: column});
            } else {
              me.setState({axis_y: column});
            }
            event.preventDefault();
          });
          contextmenu.append(option);
        });
      }, this);
    }
  }
  mountPlotXY(this: PlotXY): PlotXYInternal {
    var me = this;

    var div = d3.select(this.root_ref.current);
    me.svg = div.select("svg");
    var currently_displayed = [];
    var rerender_all_points = [];
    var zoom_brush: d3.BrushBehavior<unknown>;

    // Lines
    var graph_lines = this.canvas_lines_ref.current.getContext('2d');
    graph_lines.globalCompositeOperation = "destination-over";

    // Highlights
    var highlights = this.canvas_highlighted_ref.current.getContext('2d');
    highlights.globalCompositeOperation = "destination-over";

    const margin = {top: 20, right: 20, bottom: 50, left: 60};
    var x_scale, y_scale, yAxis, xAxis;
    var x_scale_orig: d3.AxisScale<d3.AxisDomain>, y_scale_orig: d3.AxisScale<d3.AxisDomain>;

    function redraw_axis_and_rerender() {
      var rerender_all_points_before = rerender_all_points;
      redraw_axis();
      clear_canvas();
      $.each(rerender_all_points_before, function(_, fn) {
        fn();
      });
      rerender_all_points = rerender_all_points_before;
    }
    function create_scale(param: string, range) {
      var scale = create_d3_scale(me.props.params_def[param])
      scale.range(range);
      return scale;
    }
    function redraw_axis() {
      me.svg.selectAll(".axis_render").remove();
      me.svg.selectAll(".brush").remove();
      me.svg.attr("viewBox", [0, 0, me.state.width, me.state.height]);
      me.svg.append("g").attr('class', 'axis_render').call(xAxis);
      me.svg.append("g").attr('class', 'axis_render').call(yAxis);
      me.svg.append("g").attr("class", "brush").call(zoom_brush);
    }
    function recompute_scale(force: boolean = false) {
      if (!force && !me.state.enabled) {
        return;
      }
      x_scale_orig = x_scale = create_scale(me.state.axis_x, [margin.left, me.state.width - margin.right]);
      y_scale_orig = y_scale = create_scale(me.state.axis_y, [me.state.height - margin.bottom, margin.top]);
      zoom_brush = d3.brush().extent([[margin.left, margin.top], [me.state.width - margin.right, me.state.height - margin.bottom]]).on("end", brushended);

      yAxis = g => g
        .attr("transform", `translate(${margin.left - 10},0)`)
        .call(d3.axisLeft(y_scale).ticks(1+me.state.height / 40).tickSizeInner(margin.left + margin.right - me.state.width))
        .call(g => g.select(".domain").remove())
        .call(g => g.select(".tick:last-of-type text").clone()
            .attr("x", 3)
            .attr("text-anchor", "start")
            .attr("font-weight", "bold")
            .text(me.state.axis_y));
      xAxis = g => g
        .attr("transform", `translate(0,${me.state.height - margin.bottom})`)
        .call(d3.axisBottom(x_scale).ticks(1+me.state.width / 80).tickSizeInner(margin.bottom + margin.top - me.state.height))
        .call(g => g.select(".tick:last-of-type text").clone()
            .attr("y", 22)
            .attr("text-anchor", "end")
            .attr("font-weight", "bold")
            .text(me.state.axis_x));
      div.selectAll("canvas")
        .attr("width", me.state.width - margin.left - margin.right)
        .attr("height", me.state.height - margin.top - margin.bottom);
      div.selectAll("svg")
        .attr("width", me.state.width)
        .attr("height", me.state.height);
      div.style("height", me.state.height + "px");
      div.selectAll('canvas').style('margin', margin.top + 'px ' + margin.right + 'px ' + margin.bottom + 'px ' + margin.left + 'px');

      redraw_axis();
    }
    function on_move() {
      var pos_top = $(me.root_ref.current).position().top;
      var pos_left = $(me.root_ref.current).position().left;
      div.selectAll("canvas").style("top", pos_top + "px").style("left", pos_left + "px");
      me.svg.style("top", pos_top + "px").style("left", pos_left + "px");
    }
    function brushended() {
      var s = d3.event.selection;
      if (!s) {
        x_scale = x_scale_orig;
        y_scale = y_scale_orig;
      } else {
        if (x_scale.invert !== undefined) {
          var xrange = [x_scale.invert(s[0][0]), x_scale.invert(s[1][0])];
          x_scale = create_scale(me.state.axis_x, [margin.left, me.state.width - margin.right]);
          x_scale.domain(xrange);
        }
        if (y_scale.invert !== undefined) {
          var yrange = [y_scale.invert(s[1][1]), y_scale.invert(s[0][1])];
          y_scale = create_scale(me.state.axis_y, [me.state.height - margin.bottom, margin.top]);
          y_scale.domain(yrange);
        }
      }
      redraw_axis_and_rerender();
    }
    on_move();

    function hover(svg, path) {
      var dot = me.svg.append("g")
          .attr("display", "none");

      dot.append("circle")
          .attr("r", 2.5);

      dot.append("text")
          .style("font", "10px sans-serif")
          .attr("text-anchor", "middle")
          .attr("y", -8);

      if ("ontouchstart" in document) svg
          .style("-webkit-tap-highlight-color", "transparent")
          .on("touchmove", moved)
          .on("touchstart", entered)
          .on("touchend", left)
      else svg
          .on("mousemove", moved)
          .on("mouseenter", entered)
          .on("mouseleave", left);

      function moved() {
        d3.event.preventDefault();
        var closest = null;
        var closest_dist = null;
        $.each(currently_displayed, function(_, dp) {
          var dist = (dp['layerX'] - d3.event.layerX) ** 2 + (dp['layerY'] - d3.event.layerY) ** 2;
          if (closest_dist == null || dist < closest_dist) {
            closest_dist = dist;
            closest = dp;
          }
        });
        if (closest === null) {
          dot.attr("transform", `translate(${d3.event.layerX},${d3.event.layerY})`);
          dot.select("text").text("No point found?!");
          return;
        }
        me.props.setHighlighted([me.props.dp_lookup[closest['dp'].uid]]);
        dot.attr("transform", `translate(${closest["layerX"]},${closest["layerY"]})`);
        dot.select("text").text(me.props.render_row_text(closest['dp']));
      }

      function entered() {
        dot.attr("display", null);
      }

      function left() {
        me.props.setHighlighted([]);
        dot.attr("display", "none");
      }
    };

    me.svg.call(hover);

    function render_dp(dp, ctx, c) {
      if (c.lines_color) ctx.strokeStyle = c.lines_color;
      if (c.dots_color) ctx.fillStyle = c.dots_color;
      if (c.lines_width) ctx.lineWidth = c.lines_width;
      var pdx = me.props.params_def[me.state.axis_x];
      var pdy = me.props.params_def[me.state.axis_y];
      function is_err(value, scaled_value, def) {
        return value === undefined || value === null || isNaN(scaled_value) || (def.numeric && (value == 'inf' || value == '-inf'));
      }
      function render_point_position(dp) {
        var x = x_scale(dp[me.state.axis_x]);
        var y = y_scale(dp[me.state.axis_y]);
        x -= margin.left;
        y -= margin.top;

        var err = is_err(dp[me.state.axis_x], x, pdx) || is_err(dp[me.state.axis_y], y, pdy);
        if (err) {
          return null;
        }
        if (c.remember) {
          currently_displayed.push({
            'layerX': x + margin.left,
            'layerY': y + margin.top,
            'dp': dp
          });
        }
        return {x: x, y: y};
      }
      var pos = render_point_position(dp);
      if (pos === null) {
        return;
      }
      if (dp.from_uid && c.lines_width > 0.0) {
        var dp_prev = me.props.dp_lookup[dp.from_uid];
        if (dp_prev) {
          var prev_pos = render_point_position(dp_prev);
          if (prev_pos !== null) {
            ctx.beginPath();
            ctx.moveTo(prev_pos.x, prev_pos.y);
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();
          }
        }
        else {
          console.log('DataPoint with id ' + dp.from_uid + ' not found (dp.from_uid)', dp);
        }
      }
      if (c.dots_thickness > 0) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, c.dots_thickness, 0, 2 * Math.PI, true);
        ctx.fill();
      }
    };

    function draw_selected_rows() {
      clear_canvas();
      var xp_config = me.props;
      var area = me.state.height * me.state.width / 400000;
      var lines_opacity = xp_config.lines_opacity !== null ? xp_config.lines_opacity : d3.min([3 * area / Math.pow(me.props.rows_selected.length, 0.3), 1]);
      var dots_opacity = xp_config.dots_opacity !== null ? xp_config.dots_opacity : d3.min([4 * area / Math.pow(me.props.rows_selected.length, 0.3), 1]);
      me.props.rows_selected.forEach(function(dp: Datapoint) {
        var call_render = function() {
          render_dp(dp, graph_lines, {
            'lines_color': me.props.get_color_for_row(dp, lines_opacity),
            'lines_width': xp_config.lines_thickness,
            'dots_color': me.props.get_color_for_row(dp, dots_opacity),
            'dots_thickness': xp_config.dots_thickness,
            'remember': true,
          });
        };
        rerender_all_points.push(call_render);
        if (me.state.enabled) {
          call_render();
        }
      });
    }

    function clear_canvas() {
      graph_lines.clearRect(0, 0, me.state.width, me.state.height);
      highlights.clearRect(0, 0, me.state.width, me.state.height);
      currently_displayed = [];
      rerender_all_points = [];
    };

    // Draw highlights
    function draw_highlighted() {
      if (!me.state.enabled) {
        return;
      }
      const highlighted = me.props.rows_highlighted;
      highlights.clearRect(0, 0, me.state.width, me.state.height);
      d3.select(me.canvas_highlighted_ref.current).style("opacity", "0");
      d3.select(me.canvas_lines_ref.current).style("opacity", "1.0");
      if (!highlighted.length) {  // Stop highlight
        return;
      }
      d3.select(me.canvas_highlighted_ref.current).style("opacity", "1.0");
      d3.select(me.canvas_lines_ref.current).style("opacity", "0.5");
      // Find all runs + parents
      highlighted.forEach(function(dp) {
        while (dp !== undefined) {
          var color = me.props.get_color_for_row(dp, 1.0).split(',');
          render_dp(dp, highlights, {
            'lines_color': [color[0], color[1], color[2], 1.0 + ')'].join(','),
            'lines_width': 4,
            'dots_color': [color[0], color[1], color[2], 0.8 + ')'].join(','),
            'dots_thickness': 5,
          });
          if (dp.from_uid === null) {
            break;
          }
          dp = me.props.dp_lookup[dp.from_uid];
        }
      });
    }

    // Change axis
    function update_axis() {
      var rerender_all_points_before = rerender_all_points;
      recompute_scale(true);
      clear_canvas();
      $.each(rerender_all_points_before, function(_, fn) {
        fn();
      });
      rerender_all_points = rerender_all_points_before;
    };
    update_axis();

    // Initial lines
    draw_selected_rows();

    this.on_resize = _.throttle(function(this: PlotXY) {
      recompute_scale();
      draw_selected_rows();
    }.bind(this), 75);
    return {
      clear_canvas: clear_canvas,
      update_axis: update_axis,
      recompute_scale: recompute_scale,
      draw_selected_rows: draw_selected_rows,
      draw_highlighted: draw_highlighted,
    };
  }
  onResize(height: number, width: number): void {
    if (this.state.height != height || this.state.width != width) {
      this.setState({height: height, width: width});
    }
  }
  disable(): void {
    this.setState({enabled: false, width: 0, axis_x: null, axis_y: null, height: this.state.initialHeight});
  }
  render() {
    if (!this.state.enabled) {
      return [];
    }
    return (
    <ResizableH initialHeight={this.state.height} onResize={_.debounce(this.onResize.bind(this), 100)} onRemove={this.disable.bind(this)}>
      {this.state.width > 0 && <div ref={this.root_ref} className="checkpoints-graph" style={{"height": this.state.height}}>
          <canvas ref={this.canvas_lines_ref} className={style["checkpoints-graph-lines"]} style={{position: 'absolute'}}></canvas>
          <canvas ref={this.canvas_highlighted_ref} className={style["checkpoints-graph-highlights"]} style={{position: 'absolute'}}></canvas>
          <svg className={style["checkpoints-graph-svg"]} style={{position: 'absolute'}}></svg>
      </div>}
    </ResizableH>
    );
  }
  componentWillUnmount() {
    if (this.plot) {
      this.plot.clear_canvas();
      this.svg.selectAll("*").remove();
    }
    if (this.props.context_menu_ref && this.props.context_menu_ref.current) {
      this.props.context_menu_ref.current.removeCallbacks(this);
    }
  };
  componentDidUpdate(prevProps: PlotXYProps, prevState) {
    var anyAxisChanged = false;
    ['axis_x', 'axis_y'].forEach(function(this: PlotXY, d: string) {
      if (prevState[d] != this.state[d]) {
        this.props.persistent_state.set(d, this.state[d]);
        anyAxisChanged = true;
      }
    }.bind(this));
    if (prevState.width == 0 && this.state.width > 0) {
      this.plot = this.mountPlotXY();
    }
    if (prevState.height != this.state.height || prevState.width != this.state.width) {
        if (this.on_resize) {
          this.on_resize();
        }
    }
    if (this.state.axis_x === null || this.state.axis_y === null) {
      if (this.state.enabled) {
        this.setState({enabled: false});
      }
    }
    else {
      if (this.state.enabled) {
        if (anyAxisChanged) {
          this.plot.update_axis();
        }
      } else {
        this.setState({enabled: true});
      }
    }

    // Check if data changed
    if (this.plot) {
      var scaleRecomputed = false;
      if (this.props.params_def != prevProps.params_def || this.props.colorby != prevProps.colorby) {
        this.plot.recompute_scale();
        scaleRecomputed = true;
      }
      if (this.props.rows_selected != prevProps.rows_selected || scaleRecomputed) {
        this.plot.draw_selected_rows();
      }
      if (this.props.rows_highlighted != prevProps.rows_highlighted || scaleRecomputed) {
        this.plot.draw_highlighted()
      }
    }
    this.props.window_state.height = this.state.height;
  }
}
